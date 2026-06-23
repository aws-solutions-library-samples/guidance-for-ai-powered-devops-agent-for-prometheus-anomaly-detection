# setup_guide.md — Deploy from scratch

Single source of truth for deploying this stack. See `docs/CONTEXT.md` for live IDs + handoff state.

## Prerequisites
- AWS profile `proactive-rca-demo` (account `985090322243`), region `us-east-1`
- `eksctl`, `kubectl`, `helm`, `aws` CLI, `uvx`/`uv`, Node 18+ (CDK), Python 3.10+
- `export AWS_PROFILE=proactive-rca-demo`

## Deploy order

### 1. Control plane — AMP + Prometheus MCP (CDK)
```bash
cd cdk && ../deploy/10-deploy-cdk.sh
```
Creates: AMP workspace, Cognito (m2m client + domain + scope `prometheus-mcp-server/read`),
Lambda MCP, API Gateway (`/prod/mcp`). Reinstalls gitignored Python deps from `requirements.txt`.

### 2. Register MCP with the DevOps Agent (register-only)
```bash
./deploy/20-register-agent.sh
```
Registers the MCP as a capability provider (OAuth2). **Never creates Agent Spaces.**

### 3. EKS cluster + Prometheus agent → AMP
```bash
./deploy/30-eks-open5gs.sh
```
Creates `open5gs-amp-cluster` (k8s 1.31, ng-1 2× t3.xlarge), EBS CSI + gp3 default SC,
installs kube-prometheus-stack (grafana/alertmanager disabled) with IRSA SA `amp-prometheus`
remote_writing to AMP via SigV4.

### 4. open5gs 5G core + metrics + UERANSIM
```bash
./deploy/50-open5gs.sh
```
Applies `manifests/open5gs-core.yaml` (13 NFs pod-network, mongo PVC, **UPF UDP** service),
annotates AMF/SMF/UPF/PCF for scrape, installs the `open5gs-nf` raw scrape job with
`fallback_scrape_protocol` (`manifests/open5gs-scrape.yaml`), provisions the subscriber,
and deploys UERANSIM (`manifests/ueransim.yaml`).

## Verify
```bash
export AWS_PROFILE=proactive-rca-demo
aws eks update-kubeconfig --region us-east-1 --name open5gs-amp-cluster   # pin context

# pods
kubectl get pods -n open5gs        # 13 NFs + ueransim Running
kubectl get pods -n monitoring     # prometheus-0 Running

# UE attached?
kubectl logs -n open5gs -l app=ueransim -c ue --tail=5 | grep -E "Registration is successful|PDU Session establishment is successful"

# metrics in AMP (direct SigV4)
./deploy/40-verify-amp.sh
# expect: fivegs_amffunction_rm_registeredsubnbr=1, fivegs_smffunction_sm_sessionnbr=1

# metrics via DevOps Agent MCP (OAuth2)
DOMAIN=mcp-useast1-90322243-1781865760686-xong09ga-1n9c
MCP=https://qjvbzggmf4.execute-api.us-east-1.amazonaws.com/prod/mcp
CID=1cgbivpvrehjss1bosftc8apa3
SECRET=$(aws cognito-idp describe-user-pool-client --region us-east-1 \
  --user-pool-id us-east-1_h6wlcZKPP --client-id $CID --query UserPoolClient.ClientSecret --output text)
TOKEN=$(curl -s -X POST "https://$DOMAIN.auth.us-east-1.amazoncognito.com/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$CID&client_secret=$SECRET&scope=prometheus-mcp-server/read" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -X POST "$MCP" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ExecuteQuery","arguments":{"query":"fivegs_smffunction_sm_sessionnbr"}}}'
```

## Troubleshooting (most-hit issues)
| Symptom | Cause | Fix |
|---|---|---|
| `kubectl` "No resources" / nodes=0 | nodegroup idle-scaled to 0 | scale ng-1 to desired=2 (see CONTEXT §7) |
| `kubectl` times out / i/o timeout | egress IP rotated outside allowlist | update `publicAccessCidrs` to current /8 |
| open5gs target "down: non-compliant… blank Content-Type" | Prom 3.x strictness | ensure `open5gs-nf` raw scrape job w/ `fallback_scrape_protocol` is present |
| PDU `OUT_OF_LADN` / SMF "PFCP No Response" | `upf` Service is TCP | UPF Service must be **UDP** (8805 + 2152) |
| UE `PLMN_NOT_ALLOWED` | subscriber missing (mongo wiped) | `manifests/provision-subscriber.sh`; ensure mongo PVC mounted |
| wrong cluster acted on | kubectl context crossed accounts | `aws eks update-kubeconfig --name open5gs-amp-cluster` before kubectl |

## Teardown
```bash
eksctl delete cluster -f /tmp/amp-cluster/cluster.yaml   # nodes + cluster
cd cdk && cdk destroy --all                              # AMP + MCP + Cognito + APIGW
```
