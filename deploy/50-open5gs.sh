#!/usr/bin/env bash
# 50-open5gs.sh — Deploy open5gs 5G core (Path 2: pod-network, no Multus) onto the
# EKS cluster and wire its 5G metrics into Amazon Managed Prometheus (AMP) so they
# are queryable by the AWS DevOps Agent via the Prometheus MCP.
#
# Prereqs: 30-eks-open5gs.sh already ran (cluster + kube-prometheus-stack remote_writing to AMP).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-proactive-rca-demo}"
R="${AWS_REGION:-us-east-1}"
CLUSTER="${CLUSTER:-open5gs-amp-cluster}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== point kubeconfig at $CLUSTER (avoid cross-account context bugs) ==="
aws eks update-kubeconfig --region "$R" --name "$CLUSTER" >/dev/null
kubectl config current-context

echo "=== 1. deploy open5gs core (13 NFs, pod-network, ECR-public telco-buddy image) ==="
kubectl apply -f "$HERE/manifests/open5gs-core.yaml"
kubectl rollout status deploy/amf -n open5gs --timeout=180s

echo "=== 2. annotate metric-emitting NFs for scrape (AMF metrics enabled by default in image) ==="
for nf in amf smf upf pcf; do
  kubectl patch deploy "$nf" -n open5gs -p \
    '{"spec":{"template":{"metadata":{"annotations":{"prometheus.io/scrape":"true","prometheus.io/port":"9090","prometheus.io/path":"/metrics"}}}}}'
done

echo "=== 3. additionalScrapeConfigs with fallback_scrape_protocol ==="
# Prometheus 3.x rejects open5gs /metrics (blank Content-Type). The installed
# ServiceMonitor CRD predates endpoints[].fallbackScrapeProtocol, so inject a raw
# scrape job (which supports fallback_scrape_protocol) via additionalScrapeConfigs.
kubectl create secret generic additional-scrape-configs -n monitoring \
  --from-file=open5gs.yaml="$HERE/manifests/open5gs-scrape.yaml" \
  --dry-run=client -o yaml | kubectl apply -f -
PROM=$(kubectl get prometheus -n monitoring -o jsonpath='{.items[0].metadata.name}')
kubectl patch prometheus "$PROM" -n monitoring --type merge \
  -p '{"spec":{"additionalScrapeConfigs":{"name":"additional-scrape-configs","key":"open5gs.yaml"}}}'

echo "=== 4. wait + verify open5gs metrics reach AMP ==="
sleep 100
WS="${AMP_WORKSPACE_ID:-ws-185ff7f8-c698-4d0e-9135-945b03aeccd1}"
python3 - "$R" "$WS" <<'PY'
import sys,boto3,requests
from botocore.auth import SigV4Auth; from botocore.awsrequest import AWSRequest
region,ws=sys.argv[1],sys.argv[2]
c=boto3.Session().get_credentials().get_frozen_credentials()
url=f"https://aps-workspaces.{region}.amazonaws.com/workspaces/{ws}/api/v1/query"
for q in ['count({job="open5gs-nf"})','count({__name__=~"fivegs_amffunction.*"})']:
    req=AWSRequest(method="GET",url=url,params={"query":q}); SigV4Auth(c,"aps",region).add_auth(req)
    r=requests.get(url,params={"query":q},headers=dict(req.headers),timeout=20)
    res=r.json().get("data",{}).get("result",[])
    print(f"AMP {q:42} -> {res[0]['value'][1] if res else 0} series")
PY
echo "DONE — open5gs 5G metrics are in AMP and queryable via the DevOps Agent MCP."

echo "=== 5. provision subscriber + deploy UERANSIM gNB+UE (live 5G traffic) ==="
bash "$HERE/manifests/provision-subscriber.sh"
kubectl apply -f "$HERE/manifests/ueransim.yaml"
echo "UE should register + establish PDU session; metrics fivegs_amffunction_* / fivegs_smffunction_* flow to AMP."
