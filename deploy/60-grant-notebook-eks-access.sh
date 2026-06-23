#!/usr/bin/env bash
# Grant the SageMaker Notebook IAM role access to the EKS cluster.
# Run AFTER both the CDK Notebook stack and the EKS cluster exist.
# Without this, kubectl from the notebook hangs/fails (no EKS authorization).
set -euo pipefail

REGION="${REGION:-us-east-1}"
CLUSTER="${CLUSTER:-open5gs-amp-cluster}"

echo "Finding SageMaker notebook IAM role..."
ROLE=$(aws sagemaker describe-notebook-instance \
  --region "$REGION" --notebook-instance-name open5gs-rcf-anomaly-demo \
  --query 'RoleArn' --output text)
echo "  Role: $ROLE"

echo "Creating EKS access entry..."
aws eks create-access-entry --region "$REGION" \
  --cluster-name "$CLUSTER" \
  --principal-arn "$ROLE" \
  --type STANDARD 2>/dev/null || echo "  (access entry already exists)"

echo "Associating cluster admin policy..."
aws eks associate-access-policy --region "$REGION" \
  --cluster-name "$CLUSTER" \
  --principal-arn "$ROLE" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster 2>/dev/null || echo "  (policy already associated)"

echo "✓ Notebook role granted EKS access. kubectl from the notebook will now work."
