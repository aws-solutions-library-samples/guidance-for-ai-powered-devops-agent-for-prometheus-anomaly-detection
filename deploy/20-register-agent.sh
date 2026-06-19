#!/usr/bin/env bash
# Register the Prometheus MCP (API Gateway) as a DevOps Agent capability provider (OAuth2, register-only).
# Reads CDK stack outputs + Cognito secret at runtime; NEVER creates an Agent Space.
set -euo pipefail
: "${AWS_PROFILE:=proactive-rca-demo}"; export AWS_PROFILE
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
aws devops-agent register-service --region "$AWS_REGION" --service mcpserver --service-details file:///tmp/amp-mcp-svc.json
echo "Registered Prometheus MCP capability provider (register-only)."
