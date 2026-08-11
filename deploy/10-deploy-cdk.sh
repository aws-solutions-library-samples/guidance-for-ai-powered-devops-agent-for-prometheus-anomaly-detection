#!/usr/bin/env bash
# Deploy AMP workspace + Prometheus MCP (Cognito + Lambda + API Gateway).
set -euo pipefail
: "${AWS_PROFILE:=default}"; export AWS_PROFILE
: "${AWS_REGION:=us-east-1}"; export CDK_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
cd "$(dirname "$0")/../cdk"
# Re-vendor Python deps into the Lambda asset dirs (not committed to git).
#
# Wheels MUST be resolved for the Lambda runtime (Amazon Linux, x86_64, CPython 3.11), NOT for the
# build host. A plain `pip install -t` on macOS/arm64 vendors host-native extension modules
# (pydantic_core, cryptography, rpds, charset-normalizer) and the deployed functions then fail at
# import time, e.g.:
#   Runtime.ImportModuleError: .../cryptography/hazmat/bindings/_rust.abi3.so: invalid ELF header
#   Runtime.ImportModuleError: No module named 'pydantic_core._pydantic_core'
# which surfaces as HTTP 500 on /mcp and 502 on /health.
PIP_TARGET_ARGS=(
  --platform manylinux2014_x86_64
  --implementation cp
  --python-version 3.11
  --only-binary=:all:
  --upgrade
  --quiet
)
# Drop previously vendored packages so stale host-platform artifacts can't linger across re-runs
# (pip --upgrade can treat a same-version package as satisfied and leave the wrong-platform .so).
# Only handler sources + requirements.txt are tracked (see cdk/.gitignore); this is scoped to build output.
git clean -xdfq -- lambda lambda-mcp-wrapper/lambda 2>/dev/null || true
# No `|| true` below: a resolution failure MUST fail the deploy loudly rather than ship
# missing/mismatched deps that only break at Lambda cold start.
python3 -m pip install -r lambda/requirements.txt -t lambda "${PIP_TARGET_ARGS[@]}"
python3 -m pip install -r lambda-mcp-wrapper/lambda/requirements.txt -t lambda-mcp-wrapper/lambda "${PIP_TARGET_ARGS[@]}"
npm install
npx cdk bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$AWS_REGION"
npx cdk deploy --all --require-approval never
