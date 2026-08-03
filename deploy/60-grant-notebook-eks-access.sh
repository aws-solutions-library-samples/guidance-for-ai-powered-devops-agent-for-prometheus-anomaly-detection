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

echo "✓ Notebook role granted EKS access (authorization)."

# --- VPC-attach the notebook to the EKS PRIVATE endpoint (reachability) ---
# Generic: everything resolved from the cluster by name, nothing hardcoded. This removes
# the dependency on the EKS publicAccessCidrs allowlist (a SageMaker egress IP is dynamic).
echo "Resolving cluster networking for private-endpoint access..."
VPC=$(aws eks describe-cluster --region "$REGION" --name "$CLUSTER" --query cluster.resourcesVpcConfig.vpcId --output text)
CSG=$(aws eks describe-cluster --region "$REGION" --name "$CLUSTER" --query cluster.resourcesVpcConfig.clusterSecurityGroupId --output text)
# eksctl tags private subnets with internal-elb=1; pick one that has a NAT route (internet for pip/kubectl)
SUBNET=""
for sn in $(aws ec2 describe-subnets --region "$REGION" \
      --filters "Name=vpc-id,Values=$VPC" "Name=tag:kubernetes.io/role/internal-elb,Values=1" \
      --query 'Subnets[].SubnetId' --output text); do
  NAT=$(aws ec2 describe-route-tables --region "$REGION" --filters "Name=association.subnet-id,Values=$sn" \
        --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NatGatewayId' --output text)
  if [ -n "$NAT" ] && [ "$NAT" != "None" ]; then SUBNET="$sn"; break; fi
done
if [ -z "$SUBNET" ]; then
  echo "  ! No private subnet with NAT found in $VPC; leaving notebook public."; exit 0
fi
echo "  VPC=$VPC  subnet=$SUBNET  clusterSG=$CSG"

echo "Deploying notebook VPC-attached (private endpoint)..."
export CDK_DEFAULT_REGION="$REGION"
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
( cd "$(dirname "$0")/../cdk" && npx cdk deploy Open5gsNotebookStack --require-approval never \
    -c eksVpcId="$VPC" -c eksSubnetId="$SUBNET" -c eksClusterSg="$CSG" )
echo "✓ Notebook VPC-attached to the EKS private endpoint — kubectl works with no publicAccessCidrs dependency."
