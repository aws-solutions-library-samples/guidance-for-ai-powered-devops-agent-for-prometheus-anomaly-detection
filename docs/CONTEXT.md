# CONTEXT — AI-Powered DevOps Agent for Prometheus Anomaly Detection

> **Session handoff doc.** Read this first to resume. Last updated: 2026-06-23.
> Repo: `git@ssh.gitlab.aws.dev:mdsherif/ai-powered-devops-agent-for-prometheus-anomaly-detection.git` (branch `main`).
> Local: `06Tools/24-ai-devops-amp` (keep the path SHORT — long WorkDocs paths break CDK/npm).

---

## 1. What this project is

Demonstrates the **AWS DevOps Agent doing anomaly detection on 5G telco metrics** via Amazon Managed
Prometheus (AMP). Real signal source = **open5gs 5G core + UERANSIM** on EKS; metrics flow to AMP;
the DevOps Agent queries them through the **awslabs Prometheus MCP server** (OAuth2-secured API Gateway).

**Data path (all live and proven):**
```
open5gs NFs (AMF/SMF/UPF) --/metrics:9090--> kube-prometheus-stack (Prometheus agent)
   --remote_write (SigV4/IRSA)--> AMP workspace
   <--SigV4-- Prometheus MCP (Lambda) <--OAuth2/API GW-- AWS DevOps Agent
```

## 2. Account / environment

| Item | Value |
|---|---|
| AWS account | `985090322243` |
| CLI profile | `proactive-rca-demo` |
| Region | `us-east-1` |

## 3. Live resources (control-plane — persistent)

| Resource | ID / value |
|---|---|
| **AMP workspace** | `ws-185ff7f8-c698-4d0e-9135-945b03aeccd1` |
| AMP query URL | `https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-185ff7f8-c698-4d0e-9135-945b03aeccd1` |
| AMP remote_write | `…/api/v1/remote_write` |
| **MCP endpoint** | `https://qjvbzggmf4.execute-api.us-east-1.amazonaws.com/prod/mcp` |
| Cognito user pool | `us-east-1_h6wlcZKPP` |
| Cognito m2m client | `1cgbivpvrehjss1bosftc8apa3` (scope `prometheus-mcp-server/read`) |
| Cognito domain | `mcp-useast1-90322243-1781865760686-xong09ga-1n9c` |
| Token URL | `https://<domain>.auth.us-east-1.amazoncognito.com/oauth2/token` |
| DevOps Agent capability provider | serviceId `362b7ae4-2e17-4efa-894e-4882f4742d1d` (register-only; agent spaces = 0) |
| MCP tools (PascalCase) | `ExecuteQuery`, `ExecuteRangeQuery`, `ListMetrics`, `GetServerInfo`, `GetAvailableWorkspaces` |
| CDK stacks | `Open5gsAmpStack`, `PrometheusLambdaMCPCognitoStack`, `PrometheusLambdaMCPStack`, `PrometheusLambdaMCPAPIGatewayStack` |

## 4. EKS cluster (data-plane — idle-scales to 0)

| Item | Value |
|---|---|
| Cluster | `open5gs-amp-cluster` (k8s 1.31, eksctl) |
| Nodegroup | `ng-1` — 2× t3.xlarge, private subnets |
| Node IAM role | `eksctl-open5gs-amp-cluster-nodegro-NodeInstanceRole-qKJHtn13OQyx` |
| Auth mode | `API_AND_CONFIG_MAP` (node access entry type `EC2_LINUX`, group `system:nodes`) |
| API endpoint | public+private; `publicAccessCidrs` = `3/5/13/15/18/52/54.0.0.0/8` + NAT `3.220.222.73/32` |
| Default StorageClass | `gp3` (EBS CSI addon ACTIVE) |
| IRSA SA for remote_write | `amp-prometheus` (ns `monitoring`) w/ `AmazonPrometheusRemoteWriteAccess` |
| Config file | `/tmp/amp-cluster/cluster.yaml` (eksctl) — minSize=2 (but see §7 idle-scale) |

**Namespaces:** `monitoring` (kube-prometheus-stack, grafana/alertmanager disabled), `open5gs` (13 NFs + ueransim).

## 5. open5gs / UERANSIM (Path 2 = pod-network, no Multus)

- **13 NFs** from ECR-public image `public.ecr.aws/a7y4t3f5/telco-buddy/open5gs:2.6.6` (mongo `…/mongo:6.0`).
  Image has K8s-aware default config (NFs reach each other by Service name; metrics on `eth0:9090`).
- **UERANSIM** gNB+UE in one pod (`gradiant/ueransim:3.2.6`), gNB↔AMF NGAP, UE registers + PDU session.
- **Subscriber** IMSI `999700000000001` (key/opc = open5gs defaults), DNN `internet`, slice sst:1.
  Persisted via **mongodb PVC** (`mongodb-data`, gp3) — survives pod restarts / weekend scale-to-0.
- UE gets TUN `uesimtun0` on `10.45.0.x` (SMF subnet `10.45.0.1/16`).

**Verified metrics in AMP / via MCP:** `fivegs_amffunction_rm_registeredsubnbr=1`,
`fivegs_smffunction_sm_sessionnbr=1`, SMF ~33 series, UPF ~20 series, ~90 `open5gs-nf` series total.

## 6. Critical fixes applied (do NOT regress)

### 6a. Multi-NF data-plane fixes (2026-06-23 — PDU sessions / ues_active)
The multi-NF deployment (2 AMF / 4 UPF / SMF / NSSF with custom configs) had `ues_active=0` /
no PDU sessions. Root-cause chain (all fixed, all in the custom configmaps):
1. **PFCP ephemeral-port NAT** — ClusterIP services NAT the UPF→SMF source port, breaking PFCP
   heartbeats. FIX: make `smf` + `upf1-4` Services **headless** (`clusterIP: None`) → direct
   pod-IP:8805 both ways. SMF then shows 4 clean PFCP associations.
2. **NSSF `nrfId` self-reference** — default NSSF `nsi: {dev: eth0}` makes the NSSF return its OWN
   pod IP as the `nrfId` for SMF discovery → SCP/AMF query the wrong host → 400. FIX: NSSF custom
   config `nssf.nsi[].addr: nrf.open5gs.svc.cluster.local`.
3. **SBI advertise = 0.0.0.0 (THE big one)** — custom configs used `sbi: [{addr: 0.0.0.0}]`, so
   AMF/SMF/NSSF registered `ipv4Addresses:["0.0.0.0"]` in NRF → undiscoverable → AMF gets 400 /
   "Not supported version [v2]" on `nnssf-nsselection` → `PAYLOAD_NOT_FORWARDED` → no session.
   Default NFs (AUSF/UDM/etc) use `dev: eth0` so they register the pod IP (that's why REGISTRATION
   worked but PDU sessions did not). FIX: change all custom NF sbi/pfcp/gtpc/gtpu binds from
   `addr: 0.0.0.0` to **`dev: eth0`** (binds AND advertises the pod IP). After this, PDU sessions
   establish: `fivegs_smffunction_sm_sessionnbr` and `ues_active` climb to the UE count.
4. (Optional) direct-communication: AMF/SMF custom configs use `nrf: {sbi: [{addr: nrf...}]}` and no
   `scp:` section — direct NRF discovery, avoids SCP version-routing quirks. NSSF must stay running
   (AMF hard-requires `nnssf-nsselection`; scaling NSSF to 0 → "Session Context is not in SMF").

**REMAINING (N3 throughput):** GTP-U N3 data packets (`fivegs_ep_n3_gtp_*`) still 0 — the gNB↔UPF
user-plane path / UPF NAT (`iptables MASQUERADE -s 10.45.0.0/16`) needs finishing for actual ping
throughput. Control plane (sessions/ues_active) is solved.

### 6b. Original single-NF fixes
1. **`fallback_scrape_protocol`** — Prometheus 3.x rejects open5gs `/metrics` (blank `Content-Type`).
   The installed ServiceMonitor CRD predates `endpoints[].fallbackScrapeProtocol`, so metrics are
   scraped via a raw **`additionalScrapeConfigs`** secret (`manifests/open5gs-scrape.yaml`,
   job `open5gs-nf`, `fallback_scrape_protocol: PrometheusText0.0.4`). Wired into the Prometheus CR.
   NOTE: secret key must be `open5gs.yaml` (matches the Prometheus CR's additionalScrapeConfigs key);
   scrape keeps on `__meta_kubernetes_pod_label_nf` and scrapes pod-IP:9090.
2. **UPF Service must be UDP** — PFCP (8805) + GTP-U (2152) are UDP. The base manifest had TCP, so
   SMF↔UPF PFCP association failed ("No Response. Give up!") and PDU sessions were rejected. The
   `upf` Service is now UDP. (On the *other* live cluster UPF used Multus/direct pod IP, hiding this.)
3. **MongoDB PVC** — without it the subscriber is wiped on every mongo restart → `PLMN_NOT_ALLOWED`.
4. **kubectl context discipline** — ALWAYS run `aws eks update-kubeconfig --name open5gs-amp-cluster`
   before kubectl. A wrong-context bug (pointing at the other account's `open5gs-5g-cluster`) caused a
   long false "node-join failure" chase AND an accidental aws-auth clobber of that cluster (since restored).

## 7. Known operational issues / resume checklist

The account's idle-automation **scales `ng-1` to 0 (and resets minSize to 0)** over idle periods, and
your corporate **egress IP rotates** across AWS /8 blocks. On resume:

```bash
export AWS_PROFILE=proactive-rca-demo; R=us-east-1
aws eks update-kubeconfig --region $R --name open5gs-amp-cluster   # pin context!
# 1. scale nodes back
aws eks update-nodegroup-config --region $R --cluster-name open5gs-amp-cluster \
  --nodegroup-name ng-1 --scaling-config minSize=2,maxSize=3,desiredSize=2
# 2. if kubectl times out, your IP rotated — re-allow the /8 (already covers 3/5/13/15/18/52/54)
#    aws eks update-cluster-config ... --resources-vpc-config publicAccessCidrs=...
# 3. wait for 2 Ready nodes + open5gs pods Running, then (subscriber persists via PVC):
kubectl rollout restart deploy/ueransim -n open5gs
# 4. verify (see setup_guide.md §Verify)
```

## 8. DevOps Agent / MCP client config

- **Developer agent** (`~/.kiro/agents/developer.json`) now includes the **`prometheus`** MCP server
  (`awslabs.prometheus-mcp-server@latest`, `--url` AMP workspace, `--region us-east-1`,
  `--profile proactive-rca-demo`). Loads on next agent start. This is the local/direct-SigV4 path.
- The **remote/OAuth2** path (Cognito → API GW → Lambda → AMP) is the one registered with the managed
  DevOps Agent (serviceId in §3). Get a token from the Token URL with the m2m client, then
  `POST {mcp endpoint}` JSON-RPC `tools/call ExecuteQuery`.

## 9. Repo layout

```
cdk/            CDK app (AMP + vendored Prometheus MCP Cognito/Lambda/APIGW + register-only connectivity)
deploy/         10-deploy-cdk.sh  20-register-agent.sh  30-eks-open5gs.sh  40-verify-amp.sh  50-open5gs.sh
helm/open5gs-amp/   kube-prometheus-stack values (remote_write to AMP, IRSA, generic scraping)
manifests/      open5gs-core.yaml  open5gs-scrape.yaml  ueransim.yaml  provision-subscriber.sh
docs/diagrams/  architecture.{dot,svg,png}
docs/CONTEXT.md (this file)   setup_guide.md
```
Vendored Python deps for the MCP Lambda are **gitignored** (Code Defender false-positives on
`cryptography`); `deploy/10-deploy-cdk.sh` reinstalls them via `requirements.txt`.

## 10. Cost note
EKS cluster + AMP run in `985090322243` (billable). Nodes idle-scale to 0 when idle. Tear down with
`eksctl delete cluster -f /tmp/amp-cluster/cluster.yaml` + `cdk destroy` (in `cdk/`) when done with the demo.

## 11. Status / remaining (optional)
- ✅ Headline (Agent↔AMP), open5gs core, live registration + PDU session, full session metrics → AMP → MCP.
- Optional next: data-plane traffic gen (ping over `uesimtun0`) for throughput metrics; multi-UE
  (UERANSIM StatefulSet) for richer anomaly signal; alerting rules in AMP; teardown automation.
