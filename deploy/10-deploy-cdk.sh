#!/usr/bin/env bash
# Deploy AMP workspace + Prometheus MCP (Cognito + Lambda + API Gateway).
set -euo pipefail
: "${AWS_PROFILE:=proactive-rca-demo}"; export AWS_PROFILE
: "${AWS_REGION:=us-east-1}"; export CDK_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
cd "$(dirname "$0")/../cdk"
# Re-vendor Python deps into the Lambda asset dirs (not committed to git)
python3 -m pip install -r lambda/requirements.txt -t lambda --quiet || true
python3 -m pip install -r lambda-mcp-wrapper/lambda/requirements.txt -t lambda-mcp-wrapper/lambda --quiet || true
npm install
npx cdk bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$AWS_REGION"
npx cdk deploy --all --require-approval never
