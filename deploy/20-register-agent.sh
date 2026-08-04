#!/usr/bin/env bash
# Register the Prometheus MCP (API Gateway) as a DevOps Agent capability provider (OAuth2, register-only).
# Reads CDK stack outputs + Cognito secret at runtime; NEVER creates an Agent Space.
set -euo pipefail
: "${AWS_PROFILE:=default}"; export AWS_PROFILE
: "${AWS_REGION:=us-east-1}"
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
if err="$(aws devops-agent register-service --region "$AWS_REGION" --service mcpserver \
          --service-details file:///tmp/amp-mcp-svc.json 2>&1)"; then
  echo "✓ Registered Prometheus MCP capability provider (register-only)."
elif printf '%s' "$err" | grep -q "AccessDeniedException"; then
  cat <<'MSG'
⚠  SKIPPING MCP registration — this account is not authorized for the AWS DevOps Agent
   RegisterService API yet (gated preview: "Only external and exempted accounts are allowed").

   This step is OPTIONAL. It only lets the DevOps Agent QUERY Amazon Managed Prometheus during
   an investigation. The demo still works without it: the RCF alert triggers the agent via the
   WEBHOOK (deploy/70-wire-agent-webhook.sh), and the forwarder Lambda logs the alert to
   CloudWatch regardless.

   To enable later: turn on the AWS DevOps Agent in the console, request allow-listing for the
   RegisterService API, then re-run this script. Continuing setup.
MSG
else
  echo "✗ register-service failed for a reason other than authorization:" >&2
  printf '%s\n' "$err" >&2
  exit 1
fi
