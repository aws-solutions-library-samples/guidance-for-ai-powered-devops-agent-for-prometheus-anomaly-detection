#!/usr/bin/env bash
# Deploy AMP workspace + Prometheus MCP (Cognito + Lambda + API Gateway).
set -euo pipefail
: "${AWS_PROFILE:=default}"; export AWS_PROFILE
: "${AWS_REGION:=us-east-1}"; export CDK_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
cd "$(dirname "$0")/../cdk"
# Re-vendor Python deps into the Lambda asset dirs (not committed to git).
# IMPORTANT: target the Lambda runtime platform (Linux x86_64 / cp311), NOT the build host.
# A plain 'pip install -t' on macOS vendors darwin-native wheels (pydantic_core, cryptography,
# rpds, charset-normalizer), which then fail at import on Lambda with e.g.
#   Runtime.ImportModuleError: No module named 'pydantic_core._pydantic_core'
# The flags below force manylinux cp311 wheels so the bundled .so files match the runtime.
PIP_LAMBDA_FLAGS="--platform manylinux2014_x86_64 --python-version 3.11 --implementation cp --only-binary=:all: --upgrade"
python3 -m pip install -r lambda/requirements.txt -t lambda $PIP_LAMBDA_FLAGS --quiet || true
python3 -m pip install -r lambda-mcp-wrapper/lambda/requirements.txt -t lambda-mcp-wrapper/lambda $PIP_LAMBDA_FLAGS --quiet || true
npm install
npx cdk bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$AWS_REGION"
npx cdk deploy --all --require-approval never
