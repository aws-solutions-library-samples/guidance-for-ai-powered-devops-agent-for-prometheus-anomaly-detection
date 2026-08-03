#!/usr/bin/env bash
# 30-eks-open5gs.sh — on the EKS cluster: create AMP-remote-write IRSA, deploy open5gs,
# and deploy kube-prometheus-stack (agent) that scrapes everything and remote_writes to AMP.
set -euo pipefail
: "${AWS_PROFILE:=default}"; export AWS_PROFILE
: "${AWS_REGION:=us-east-1}"
: "${CLUSTER:=open5gs-amp-cluster}"
HERE="$(cd "$(dirname "$0")" && pwd)"

aws eks update-kubeconfig --region "$AWS_REGION" --name "$CLUSTER"

echo "1) IRSA service account for AMP remote_write (aps:RemoteWrite)"
kubectl create ns monitoring --dry-run=client -o yaml | kubectl apply -f -
eksctl create iamserviceaccount \
  --cluster "$CLUSTER" --region "$AWS_REGION" \
  --namespace monitoring --name amp-prometheus \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonPrometheusRemoteWriteAccess \
  --approve --override-existing-serviceaccounts

echo "2) gp3 default storage class"
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

echo "3) Deploy open5gs 5G core (towards5gs)"
helm repo add towards5gs https://raw.githubusercontent.com/Orange-OpenSource/towards5gs-helm/main/repo/ 2>/dev/null || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo update
helm upgrade --install open5gs towards5gs/open5gs -n open5gs --create-namespace --wait --timeout 8m || \
  echo "NOTE: open5gs install via towards5gs needs Multus for some NFs; core NFs should still emit metrics."

echo "4) Deploy metrics pipeline -> AMP (remote_write URL resolved from the workspace by alias)"
WS=$(aws amp list-workspaces --alias open5gs-amp --region "$AWS_REGION" --query 'workspaces[0].workspaceId' --output text)
if [ -z "$WS" ] || [ "$WS" = "None" ]; then
  echo "ERROR: no AMP workspace with alias 'open5gs-amp' in $AWS_REGION. Deploy the CDK AMP stack first."; exit 1
fi
RW_URL="https://aps-workspaces.${AWS_REGION}.amazonaws.com/workspaces/${WS}/api/v1/remote_write"
echo "   remote_write -> $RW_URL"
helm dependency update "$HERE/../helm/open5gs-amp"
helm upgrade --install open5gs-amp "$HERE/../helm/open5gs-amp" -n monitoring \
  --set-string "kube-prometheus-stack.prometheus.prometheusSpec.remoteWrite[0].url=${RW_URL}" \
  --set-string "kube-prometheus-stack.prometheus.prometheusSpec.remoteWrite[0].sigv4.region=${AWS_REGION}" \
  --set-string "amp.remoteWriteUrl=${RW_URL}" \
  --set-string "amp.region=${AWS_REGION}"

echo "Done. Verify metrics land in AMP with deploy/40-verify-amp.sh"
