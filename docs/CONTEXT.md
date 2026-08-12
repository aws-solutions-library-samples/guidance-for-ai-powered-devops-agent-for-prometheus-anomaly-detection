# CONTEXT — AI-Powered DevOps Agent for Prometheus Anomaly Detection

> **Internal engineering reference / session-handoff notes — NOT required for deployment.**
> The published deployment steps live in [`../README.md`](../README.md) and [`../setup_guide.md`](../setup_guide.md).
> Resource IDs below are placeholders (`<...>`); real values are discovered at runtime from stack outputs.
> Last updated: 2026-06-23.

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
| AWS account | `YOUR_ACCOUNT_ID` |
| CLI profile | `YOUR_AWS_PROFILE` |
| Region | `us-east-1` |

## 3. Live resources (control-plane — persistent)

| Resource | ID / value |
|---|---|
| **AMP workspace** | `YOUR_AMP_WORKSPACE_ID` |
| AMP query URL | `https://aps-workspaces.us-east-1.amazonaws.com/workspaces/YOUR_AMP_WORKSPACE_ID` |
| AMP remote_write | `…/api/v1/remote_write` |
| **MCP endpoint** | `https://<mcp-api-id>.execute-api.us-east-1.amazonaws.com/prod/mcp` |
| Cognito user pool | `<cognito-user-pool-id>` |
| Cognito m2m client | `<cognito-m2m-client-id>` (scope `prometheus-mcp-server/read`) |
| Cognito domain | `<cognito-domain>` |
| Token URL | `https://<domain>.auth.us-east-1.amazoncognito.com/oauth2/token` |
| DevOps Agent capability provider | serviceId `<service-id>` (register-only; agent spaces = 0) |
| MCP tools (PascalCase) | `ExecuteQuery`, `ExecuteRangeQuery`, `ListMetrics`, `GetServerInfo`, `GetAvailableWorkspaces` |
| CDK stacks | `Open5gsAmpStack`, `PrometheusLambdaMCPCognitoStack`, `PrometheusLambdaMCPStack`, `PrometheusLambdaMCPAPIGatewayStack` |

## 4. EKS cluster (data-plane — idle-scales to 0)

| Item | Value |
|---|---|
| Cluster | `open5gs-amp-cluster` (k8s 1.31, eksctl) |
| Nodegroup | `ng-1` — 2× t3.xlarge, private subnets |
| Node IAM role | `<node-instance-role>` |
| Auth mode | `API_AND_CONFIG_MAP` (node access entry type `EC2_LINUX`, group `system:nodes`) |
| API endpoint | public+private; `publicAccessCidrs` = `3/5/13/15/18/52/54.0.0.0/8` + NAT `YOUR_ADMIN_IP/32` |
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
5. **UPF `ogstun` DOWN → N3 user-plane dead (2026-06-24)** — running `open5gs-upfd -c custom.yaml`
   as the container command BYPASSES the image entrypoint that creates/brings-up the `ogstun` TUN
   device. open5gs-upfd creates ogstun but leaves it `state DOWN` with no IP → UPF receives N3
   uplink but `ogs_tun_write() failed (Input/output error)` → 100% packet loss. FIX: a **postStart
   lifecycle hook** on each UPF container (waits for ogstun, then `ip addr add <GW>/16 dev ogstun;
   ip link set ogstun up; sysctl -w net.ipv4.ip_forward=1; iptables -t nat -A POSTROUTING -s
   <subnet> ! -o ogstun -j MASQUERADE`). GWs: upf1 10.45.0.1, upf2 10.46.0.1, upf3 10.47.0.1,
   upf4 10.48.0.1. Persistent across restarts. After this: UE ping to gateway AND 8.8.8.8 = 0% loss.

**TRAFFIC METRIC NOTE:** open5gs 2.6.6 exports `fivegs_ep_n3_gtp_indatapktn3upf` /
`outdatapktn3upf` but they **do NOT increment** in the UPF data path (build limitation — stay 0
even with confirmed 0%-loss traffic). Use **container network metrics** instead for throughput:
`sum(rate(container_network_receive_bytes_total{namespace="open5gs",pod=~"upf.*"}[2m]))` (cAdvisor →
AMP). Sessions/bearers ARE accurate: `fivegs_upffunction_upf_sessionnbr` (250/UPF at 1000 UEs).

### 6c. Scale: 1000 UEs / 100 gNBs (2026-06-24)
- `manifests/ueransim-multi.yaml`: 4 StatefulSets × 25 pods, each pod runs `nr-ue -n 10` = **1000 UEs**.
  Per-pod base IMSI = `IMSI_START + ordinal*10`; IMSI format `99970000000%04d` (0001-1000).
  DNN split: gnb1a internet (0001-0250), gnb1b internet2 (0251-0500), gnb2a iot (0501-0750),
  gnb2b edge (0751-1000) → 250 sessions each on upf1-4. traffic-gen pings DNN gateway from all 10
  uesimtun0-9 (drives real N3 traffic, no internet dependency).
- `manifests/provision-1000-subscribers.sh`: single mongosh `bulkWrite` (fast) for 1000 subs / 4 DNNs.
- **VERIFIED:** 1000 registered, ~1000 sessions (250/UPF), ~150 KB/s user-plane traffic across UPFs.
- Capacity on 3× t3.xlarge: ~18-30% CPU, ~15% mem. Nodegroup `ng-1` scales 0↔3 for cost
  (`aws eks update-nodegroup-config --scaling-config minSize=3,maxSize=4,desiredSize=3`).

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
export AWS_PROFILE=YOUR_AWS_PROFILE; R=us-east-1
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
  `--profile YOUR_AWS_PROFILE`). Loads on next agent start. This is the local/direct-SigV4 path.
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
EKS cluster + AMP run in `YOUR_ACCOUNT_ID` (billable). Nodes idle-scale to 0 when idle. Tear down with
`eksctl delete cluster -f /tmp/amp-cluster/cluster.yaml` + `cdk destroy` (in `cdk/`) when done with the demo.

## 11. Status / remaining (optional)
- ✅ Headline (Agent↔AMP), open5gs core, live registration + PDU session, full session metrics → AMP → MCP.
- Optional next: data-plane traffic gen (ping over `uesimtun0`) for throughput metrics; multi-UE
  (UERANSIM StatefulSet) for richer anomaly signal; alerting rules in AMP; teardown automation.
