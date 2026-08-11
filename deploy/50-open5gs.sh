#!/usr/bin/env bash
# 50-open5gs.sh
#
# Deploys the open5gs 5G core (2 AMFs, 1 SMF, 4 UPFs + supporting NFs) and the
# UERANSIM RAN (100 gNodeBs, 1,000 UEs) onto the EKS cluster created in step 30.
# Provisions 1,000 subscribers into MongoDB and wires additional-scrape-configs
# so Prometheus scrapes the 5G metrics and remote-writes them to Amazon Managed
# Service for Prometheus.
#
# Sequence matters:
#   1. Base multi-NF manifest         (Deployments, ConfigMaps with default configs, Services)
#   2. live-fixes ConfigMap overlay   (working configs: dev:eth0 SBI/PFCP/GTPU binds,
#                                     direct-NRF discovery, NSSF nsi -> real NRF, etc.)
#   3. Restart the NFs                (so amf1/amf2/smf/nssf/upf1-4 pick up the overlay
#                                     ConfigMaps instead of booting with the broken defaults)
#   4. additionalScrapeConfigs        (Prometheus 3.x needs fallback_scrape_protocol because
#                                     open5gs /metrics has a blank Content-Type)
#   5. Provision 1000 subscribers     (single mongosh bulkWrite across 4 DNNs)
#   6. UERANSIM multi-gNB RAN         (4 StatefulSets x 25 pods x 10 UEs = 1000 UEs)
#
# Prereqs: 30-eks-open5gs.sh already ran (cluster + kube-prometheus-stack).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-default}"
R="${AWS_REGION:-us-east-1}"
CLUSTER="${CLUSTER:-open5gs-amp-cluster}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

for bin in aws kubectl; do
  command -v "$bin" >/dev/null || { echo "ERROR: '$bin' is required and not on PATH"; exit 1; }
done

echo "=== point kubeconfig at $CLUSTER (avoid cross-account context bugs) ==="
# Give THIS run its own kubeconfig file so a concurrent `aws eks update-kubeconfig` in
# another shell (or another deploy step) can't switch our current-context out from under
# us mid-script. This was the actual root cause of transient "namespaces open5gs not
# found" errors in step 4: kubectl was silently pointed at a different cluster after
# another aws eks update-kubeconfig ran against ~/.kube/config in parallel.
export KUBECONFIG="$(mktemp -t open5gs-deploy-kubeconfig-XXXX)"
trap 'rm -f "$KUBECONFIG"' EXIT
aws eks update-kubeconfig --region "$R" --name "$CLUSTER" >/dev/null
kubectl config current-context

echo "=== 1. Deploy the multi-NF open5gs core (2 AMFs, 1 SMF, 4 UPFs, supporting NFs) ==="
kubectl apply -f "$HERE/manifests/open5gs-core-multi.yaml"

echo "=== 2. Overlay working configs (dev:eth0 binds, direct-NRF, NSSF fixes, ogstun postStart) ==="
# Required — the base manifest ships with configs that do not fully work in-cluster.
kubectl apply -f "$HERE/manifests/open5gs-core-live-fixes.yaml"

echo "=== 3. Restart NFs so they pick up the overlaid configs ==="
# Deleting the pods (rather than 'rollout restart') so the ReplicaSet recreates with
# the fresh ConfigMap mount immediately. The dependency-order NFs are handled first.
for nf in nrf scp nssf ausf udm udr pcf bsf smf upf1 upf2 upf3 upf4 amf1 amf2; do
  kubectl delete pod -n open5gs -l "app=$nf" --wait=false --ignore-not-found >/dev/null 2>&1 || true
done

echo "=== 4. Wait for the control-plane and data-plane NFs to be Ready ==="
for d in mongodb nrf smf amf1 amf2 upf1 upf2 upf3 upf4; do
  kubectl rollout status "deploy/$d" -n open5gs --timeout=300s
done

echo "=== 5. Annotate metric-emitting NFs for scrape (metrics enabled by default in the image) ==="
for nf in amf1 amf2 smf pcf upf1 upf2 upf3 upf4; do
  kubectl patch deploy "$nf" -n open5gs -p \
    '{"spec":{"template":{"metadata":{"annotations":{"prometheus.io/scrape":"true","prometheus.io/port":"9090","prometheus.io/path":"/metrics"}}}}}' >/dev/null 2>&1 || true
done

echo "=== 6. additionalScrapeConfigs with fallback_scrape_protocol (Prometheus 3.x) ==="
# Injects a raw scrape job. Uses fallback_scrape_protocol because the installed
# ServiceMonitor CRD predates endpoints[].fallbackScrapeProtocol and open5gs /metrics
# responds with a blank Content-Type that Prometheus 3.x rejects on the negotiated path.
kubectl create secret generic additional-scrape-configs -n monitoring \
  --from-file=open5gs.yaml="$HERE/manifests/open5gs-scrape.yaml" \
  --dry-run=client -o yaml | kubectl apply -f -
PROM=$(kubectl get prometheus -n monitoring -o jsonpath='{.items[0].metadata.name}')
kubectl patch prometheus "$PROM" -n monitoring --type merge \
  -p '{"spec":{"additionalScrapeConfigs":{"name":"additional-scrape-configs","key":"open5gs.yaml"}}}'

echo "=== 7. Provision 1000 subscribers (4 DNNs x 250 UEs) via bulkWrite ==="
bash "$HERE/manifests/provision-1000-subscribers.sh"

echo "=== 8. Deploy UERANSIM RAN — paced to avoid AMF overload ==="
# The manifest defines 4 StatefulSets with replicas: 25 (100 gNBs, 1000 UEs). If they all
# come up simultaneously, 1000 UEs attach in a burst and open5gs 2.6.6 AMFs can crash with
# SIGSEGV (exit 139); UEs that hit the crash window then get stuck in "PLMN selection
# failure, no cells in coverage" and never retry. Pacing the rollout — one StatefulSet at
# a time with a gap for UEs to register — avoids the storm entirely.
#
# The manifest is applied once, then we immediately scale all StatefulSets to 0 so we can
# bring them up serially. The initial 'scale --replicas=0' is fast enough that even if
# some pods have started creating, they terminate cleanly.
kubectl apply -f "$HERE/manifests/ueransim-multi.yaml"
for sts in gnb1a gnb1b gnb2a gnb2b; do
  kubectl scale statefulset/$sts -n open5gs --replicas=0 >/dev/null
done
for sts in gnb1a gnb1b gnb2a gnb2b; do
  echo "  --- $sts: scaling to 25 replicas (250 UEs on TAC $(echo $sts | tr -d 'gnb' | head -c1))..."
  kubectl scale statefulset/$sts -n open5gs --replicas=25
  kubectl rollout status statefulset/$sts -n open5gs --timeout=300s
  echo "      waiting 60s for UEs to register before the next batch..."
  sleep 60
done

echo "=== 9. Verify open5gs metrics reach AMP (UEs registered during the paced rollout above) ==="
sleep 30    # small buffer for the last StatefulSet's UEs
WS="${AMP_WORKSPACE_ID:-$(aws amp list-workspaces --alias open5gs-amp --region "$R" --query 'workspaces[0].workspaceId' --output text)}"
python3 - "$R" "$WS" <<'PY'
import sys, boto3, requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
region, ws = sys.argv[1], sys.argv[2]
c = boto3.Session().get_credentials().get_frozen_credentials()
url = f"https://aps-workspaces.{region}.amazonaws.com/workspaces/{ws}/api/v1/query"
for q in [
    'sum(fivegs_amffunction_rm_registeredsubnbr)',
    'count(fivegs_amffunction_rm_registeredsubnbr)',
    'sum(fivegs_upffunction_upf_sessionnbr)',
]:
    req = AWSRequest(method="GET", url=url, params={"query": q})
    SigV4Auth(c, "aps", region).add_auth(req)
    r = requests.get(url, params={"query": q}, headers=dict(req.headers), timeout=20)
    res = r.json().get("data", {}).get("result", [])
    val = res[0]["value"][1] if res else "0"
    print(f"AMP {q:60} -> {val}")
PY

cat <<'MSG'

Done. Expected results after settling (~2-3 minutes):
  - sum(fivegs_amffunction_rm_registeredsubnbr)   == 1000    (500 on amf1, 500 on amf2)
  - sum(fivegs_upffunction_upf_sessionnbr)        ~= 1000    (250 per UPF)

Next: run the SageMaker notebook (open5gs-rcf-anomaly-demo).
MSG
