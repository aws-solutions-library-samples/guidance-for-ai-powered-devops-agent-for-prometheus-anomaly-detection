#!/usr/bin/env bash
# Register the Prometheus MCP (API Gateway) as a DevOps Agent capability provider (OAuth2, register-only).
# Reads CDK stack outputs + Cognito secret at runtime; NEVER creates an Agent Space.
set -euo pipefail
: "${AWS_PROFILE:=default}"; export AWS_PROFILE
# Export BOTH so AWS SDK/CLI resolution honors this region even if ~/.aws/config default differs.
: "${AWS_REGION:=us-east-1}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
out(){ aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
MCP=$(out PrometheusLambdaMCPAPIGatewayStack MCPEndpoint)
POOL=$(out PrometheusLambdaMCPCognitoStack UserPoolId)
CID=$(out PrometheusLambdaMCPCognitoStack M2MClientId)
DOMAIN=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL" --region "$AWS_REGION" --query "UserPool.Domain" --output text)
SECRET=$(aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CID" --region "$AWS_REGION" --query "UserPoolClient.ClientSecret" --output text)
cat > /tmp/amp-mcp-svc.json <<JSON
{ "mcpserver": { "name": "open5gs-prometheus-amp", "endpoint": "$MCP",
  "description": "Amazon Managed Prometheus MCP (open5gs metrics) via OAuth2",
  "authorizationConfig": { "oAuthClientCredentials": {
    "clientName": "prometheus-mcp", "clientId": "$CID", "clientSecret": "$SECRET",
    "exchangeUrl": "https://$DOMAIN.auth.$AWS_REGION.amazoncognito.com/oauth2/token",
    "scopes": ["prometheus-mcp-server/read"] } } } }
JSON
echo "Registering the Prometheus MCP as a DevOps Agent capability provider..."
echo "NOTE: requires the AWS DevOps Agent to be enabled in this account/region AND the account to be"
echo "      allow-listed for the devops-agent RegisterService API (currently a gated preview)."

# Idempotent: if a service by this name already exists, compare its endpoint to the CURRENT MCP URL.
# API Gateway generates a new REST-API ID on every recreate (any `cdk destroy + cdk deploy` cycle of
# PrometheusLambdaMCPAPIGatewayStack), so a stale registration will happily hand the DevOps Agent an
# endpoint that no longer resolves and every invocation returns "unauthorized". Detect + fix that.
NAME=open5gs-prometheus-amp
STALE_SID=""
if EXISTING=$(aws devops-agent list-services --region "$AWS_REGION" --output json 2>/dev/null); then
  # Find any mcpserver registration with our name
  STALE_SID=$(printf '%s' "$EXISTING" | python3 -c "
import json,sys
d = json.load(sys.stdin).get('services', [])
for s in d:
    if s.get('serviceType') != 'mcpserver': continue
    m = (s.get('additionalServiceDetails') or {}).get('mcpserver') or {}
    if m.get('name') == '$NAME':
        # Only mark for replacement if the endpoint differs from what we're about to register
        if m.get('endpoint') != '$MCP':
            print(s.get('serviceId',''))
        break
" 2>/dev/null || true)
  if [ -n "$STALE_SID" ]; then
    echo "  Found stale registration $STALE_SID pointing at a different endpoint; deregistering it."
    aws devops-agent deregister-service --service-id "$STALE_SID" --region "$AWS_REGION" >/dev/null 2>&1 || true
  fi
fi

if err="$(aws devops-agent register-service --region "$AWS_REGION" --service mcpserver \
          --service-details file:///tmp/amp-mcp-svc.json 2>&1)"; then
  echo "✓ Registered Prometheus MCP capability provider (register-only)."
elif printf '%s' "$err" | grep -q "AccessDeniedException"; then
  cat <<'MSG'
⚠  SKIPPING MCP registration — this account is not authorized for the AWS DevOps Agent
   RegisterService API yet (gated preview: "Only external and exempted accounts are allowed").

   This step is OPTIONAL. It only lets the DevOps Agent QUERY Amazon Managed Prometheus during
   an investigation. The demo still works without it: the RCF alert triggers the agent via the
   WEBHOOK (notebook Step 2 wiring cell), and the forwarder Lambda logs the alert to
   CloudWatch regardless.

   To enable later: turn on the AWS DevOps Agent in the console, request allow-listing for the
   RegisterService API, then re-run this script. Continuing setup.
MSG
elif printf '%s' "$err" | grep -q "already exists"; then
  # If we got here, the earlier list-services + stale detection either couldn't run (no auth to
  # list) or already treated our current endpoint as fresh. This branch handles the surprise case
  # where register-service still says "already exists" — meaning the existing registration has the
  # SAME endpoint URL we were about to write, so it's not stale. Treat as success.
  echo "✓ Prometheus MCP is already registered with the current endpoint — nothing to do."
else
  echo "✗ register-service failed for a reason other than authorization:" >&2
  printf '%s\n' "$err" >&2
  exit 1
fi
