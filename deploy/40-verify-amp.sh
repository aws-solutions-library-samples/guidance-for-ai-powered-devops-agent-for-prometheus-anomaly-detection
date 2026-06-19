#!/usr/bin/env bash
# Verify: (1) metrics in AMP via SigV4, (2) agent path via MCP (OAuth2 -> /mcp -> AMP).
set -euo pipefail
: "${AWS_PROFILE:=proactive-rca-demo}"; export AWS_PROFILE
: "${AWS_REGION:=us-east-1}"
WS=$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name Open5gsAmpStack --query "Stacks[0].Outputs[?OutputKey=='WorkspaceId'].OutputValue" --output text)
echo "AMP workspace: $WS  — query count(up):"
python3 - "$WS" "$AWS_REGION" <<'PY'
import sys,boto3,requests
from botocore.auth import SigV4Auth; from botocore.awsrequest import AWSRequest
ws,region=sys.argv[1],sys.argv[2]
c=boto3.Session(region_name=region).get_credentials().get_frozen_credentials()
url=f"https://aps-workspaces.{region}.amazonaws.com/workspaces/{ws}/api/v1/query"
req=AWSRequest(method="GET",url=url,params={"query":"count(up)"}); SigV4Auth(c,"aps",region).add_auth(req)
print(requests.get(url,params={"query":"count(up)"},headers=dict(req.headers),timeout=20).json()["data"]["result"])
PY
echo "(agent path) use deploy/20-register-agent.sh creds + POST tools/call ExecuteQuery to the MCP endpoint."
