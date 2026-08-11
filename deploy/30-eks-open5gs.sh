#!/usr/bin/env bash
# 30-eks-open5gs.sh
#
# Creates the EKS cluster if it does not exist, enables IRSA, installs the
# addons this Guidance needs, sets gp3 as the default storage class, and
# deploys kube-prometheus-stack in agent mode remote_writing to Amazon
# Managed Service for Prometheus (AMP).
#
# The open5gs 5G core + UERANSIM RAN are deployed by ./50-open5gs.sh.
set -euo pipefail
: "${AWS_PROFILE:=default}"; export AWS_PROFILE
: "${AWS_REGION:=us-east-1}"
: "${CLUSTER:=open5gs-amp-cluster}"
: "${K8S_VERSION:=1.31}"
: "${NG_NAME:=ng-1}"
: "${NG_INSTANCE_TYPE:=t3.xlarge}"
: "${NG_DESIRED:=3}"
: "${NG_MIN:=3}"
: "${NG_MAX:=4}"
HERE="$(cd "$(dirname "$0")" && pwd)"

for bin in aws eksctl kubectl helm; do
  command -v "$bin" >/dev/null || { echo "ERROR: '$bin' is required and not on PATH"; exit 1; }
done

echo "1) EKS cluster: $CLUSTER (region $AWS_REGION, k8s $K8S_VERSION)"
if aws eks describe-cluster --name "$CLUSTER" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "   Cluster already exists — skipping create."
else
  echo "   Cluster not found — creating with eksctl (this takes ~15 minutes)..."
  CFG=$(mktemp -t cluster.yaml)
  cat > "$CFG" <<YAML
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: ${CLUSTER}
  region: ${AWS_REGION}
  version: "${K8S_VERSION}"
iam:
  withOIDC: true                     # required for IRSA (amp-prometheus, EBS CSI, notebook access)
managedNodeGroups:
  - name: ${NG_NAME}
    instanceType: ${NG_INSTANCE_TYPE}
    amiFamily: AmazonLinux2023
    volumeSize: 30
    volumeType: gp3
    minSize: ${NG_MIN}
    desiredCapacity: ${NG_DESIRED}
    maxSize: ${NG_MAX}
    privateNetworking: true          # nodes in private subnets, egress via managed NAT
    iam:
      withAddonPolicies:
        ebs: true                    # gp3 PVCs (mongo, prometheus)
        cloudWatch: true
        autoScaler: true
addons:
  - name: vpc-cni
  - name: coredns
  - name: kube-proxy
  - name: aws-ebs-csi-driver         # needed for the gp3 default StorageClass below
  - name: metrics-server
cloudWatch:
  clusterLogging:
    enableTypes: ["audit", "authenticator", "controllerManager"]
YAML
  eksctl create cluster -f "$CFG"
  rm -f "$CFG"
fi

# Isolate kubectl from parallel shells: give this run its own kubeconfig so a concurrent
# `aws eks update-kubeconfig` (another deploy step, another terminal) can't switch our
# current-context mid-run. Prevents transient "namespaces X not found" / auth errors.
export KUBECONFIG="$(mktemp -t open5gs-deploy-kubeconfig-XXXX)"
trap 'rm -f "$KUBECONFIG"' EXIT
aws eks update-kubeconfig --region "$AWS_REGION" --name "$CLUSTER"
kubectl wait --for=condition=Ready nodes --all --timeout=10m

echo "2) IRSA service account for AMP remote_write (aps:RemoteWrite)"
kubectl create ns monitoring --dry-run=client -o yaml | kubectl apply -f -
eksctl create iamserviceaccount \
  --cluster "$CLUSTER" --region "$AWS_REGION" \
  --namespace monitoring --name amp-prometheus \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonPrometheusRemoteWriteAccess \
  --approve --override-existing-serviceaccounts

echo "3) gp3 default storage class"
cat <<YAML | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: gp3, annotations: { storageclass.kubernetes.io/is-default-class: "true" } }
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters: { type: gp3, encrypted: "true" }
YAML
kubectl patch sc gp2 -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}' 2>/dev/null || true

echo "4) Deploy kube-prometheus-stack -> remote_write to AMP (URL resolved from the workspace alias)"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo update
WS=$(aws amp list-workspaces --alias open5gs-amp --region "$AWS_REGION" --query 'workspaces[0].workspaceId' --output text)
if [ -z "$WS" ] || [ "$WS" = "None" ]; then
  echo "ERROR: no AMP workspace with alias 'open5gs-amp' in $AWS_REGION. Run deploy/10-deploy-cdk.sh first."; exit 1
fi
RW_URL="https://aps-workspaces.${AWS_REGION}.amazonaws.com/workspaces/${WS}/api/v1/remote_write"
echo "   remote_write -> $RW_URL"
helm dependency update "$HERE/../helm/open5gs-amp"
helm upgrade --install open5gs-amp "$HERE/../helm/open5gs-amp" -n monitoring \
  --set-string "kube-prometheus-stack.prometheus.prometheusSpec.remoteWrite[0].url=${RW_URL}" \
  --set-string "kube-prometheus-stack.prometheus.prometheusSpec.remoteWrite[0].sigv4.region=${AWS_REGION}" \
  --set-string "amp.remoteWriteUrl=${RW_URL}" \
  --set-string "amp.region=${AWS_REGION}"

echo "Done. Cluster is ready. Next: ./50-open5gs.sh (deploys the open5gs 5G core + UERANSIM RAN)."
