# RCF Anomaly Detection Demo Runbook

## Scenario: Bad Config Push → AMF1 CrashLoop → ~500 Users Impacted

### Architecture
```
1000 UEs → 100 gNBs → 2 AMFs (TAC partitioned) → 1 SMF → 4 UPFs
                          │
                     AMF1 (TAC=1, 500 UEs)  ← FAULT INJECTED HERE
                     AMF2 (TAC=2, 500 UEs)  ← UNAFFECTED
```
- 1000 UEs = 100 gNB pods × 10 UEs (`nr-ue -n 10`), 4 DNNs → 250 PDU sessions per UPF.
- Continuous user-plane traffic: each gNB pod pings its DNN gateway from all 10 tunnels.

### RCF Detector
- **Alias**: `5g-registered-subscribers`
- **Query**: `sum(fivegs_amffunction_rm_registeredsubnbr)`
- **Eval interval**: 30s
- **Training**: shingle 8, sample 256
- **Alert threshold**: score > 0.1, for: 0s (`RCF5GRegistrationDrop`)

### Timeline

| Time | Event | Metric |
|---|---|---|
| T-baseline | RCF learns baseline (1000 registered) | score = 0.0 |
| T+0 | `./manifests/fault-inject-amf1.sh break` | — |
| T+5s | AMF1 crashes (CrashLoopBackOff, exit 255) | `restarts_total` climbing |
| T+10s | 500 UEs on AMF1 deregister | `registeredsubnbr`: 1000→500 |
| T+30s | RCF evaluates the step change | **score spikes to ~1.0** (> 0.1) |
| T+30s | Alert fires | `RCF5GRegistrationDrop` FIRING |
| T+1-2m | RCF adapts to new level | score → 0.0 (band re-centers on 500) |
| T+Xm | `./manifests/fault-inject-amf1.sh fix` | AMF1 recovers |
| T+X+2-3m | 500 UEs re-register | `registeredsubnbr`: 500→1000 |

> **Critical:** the score spike lasts a **single ~30s cycle**, then the model adapts and the score
> returns to 0. To see it, query the score over a **time range** (not an instant query) — see below.

---

## Run the Demo (CLI)

### Prerequisites
```bash
export AWS_PROFILE=YOUR_AWS_PROFILE
aws eks update-kubeconfig --region us-east-1 --name open5gs-amp-cluster
```

### 1. Set up & wire the AWS DevOps Agent  ← do this BEFORE the fault
So the anomaly **automatically launches an investigation**, wire the agent first:
1. **Create an Agent Space** in the AWS DevOps Agent console (isolated workspace: account access, users, data, chat history).
2. **Add the Prometheus MCP** as a capability provider, pointing at the `/mcp` API Gateway endpoint this project deployed (OAuth2 client-credentials from the Cognito stack):
   ```bash
   ./deploy/20-register-agent.sh
   ```
3. **Generate a webhook** — Agent Space → Capabilities → Webhook → *Generate webhook*. Pick an auth type:
   **HMAC** (recommended — signed, verified via `x-amzn-event-signature`) or **API key** (`Authorization: Bearer`). Copy the URL + secret (shown once).
4. **Wire it** so the forwarder Lambda posts incidents to the agent (secret is read at runtime — no redeploy):
   ```bash
   ./deploy/70-wire-agent-webhook.sh        # prompts for URL + secret (hidden) + auth type
   ```
   (Or run the notebook's **Step 2** wiring cell.) Stores `{url, token, auth}` in Secrets Manager `open5gs/devops-agent/webhook`.

### 2. Verify baseline (before fault)
```bash
# sum(fivegs_amffunction_rm_registeredsubnbr) should be 1000 (AMF1=500, AMF2=500)
# anomaly_detector:score{alias="5g-registered-subscribers"} should be 0
./manifests/fault-inject-amf1.sh status
```

### 3. Inject fault
```bash
./manifests/fault-inject-amf1.sh break    # removes time.t3512 → AMF1 CrashLoopBackOff
```

### 4. Watch the automated DevOps Agent investigation
The fault crosses the RCF threshold and the pipeline runs with **no human in the loop**:
```
RCF5GRegistrationDrop (score > 0.1) → AMP Alertmanager → SNS (open5gs-rcf-rca-trigger)
  → forwarder Lambda (open5gs-rcf-rca) → your DevOps Agent webhook → autonomous investigation
```
```bash
kubectl get pods -n open5gs -l app=amf1 -w     # AMF1 → CrashLoopBackOff
# Confirm the Lambda forwarded the incident (look for "Agent webhook status: 2xx"):
#   aws logs filter-log-events --log-group-name /aws/lambda/open5gs-rcf-rca --start-time <epoch-ms>
```
Then open **DevOps Agent Space → Incidents** — the agent has started investigating and will surface the
root cause (AMF1 CrashLoopBackOff, missing `time.t3512`). If the webhook isn't wired, the Lambda just
logs the alert to CloudWatch and forwards nothing.

### 5. Recover
```bash
./manifests/fault-inject-amf1.sh fix       # restores config + restarts gnb1a/gnb1b
```

The notebook (`cdk/notebook/rcf-anomaly-detection-demo.ipynb`) runs all of this with annotated output —
including the **Step 2** agent-wiring cells (before the fault) and the **Step 5** automated-investigation confirmation.

---

## What the DevOps Agent Correlates (reference)

These are the signals the DevOps Agent queries (via the Prometheus MCP) during its **automated** investigation
in step 4 above. Run them manually only if you want to verify the agent's conclusion against ground truth.

### Step 1: Confirm the anomaly — USE A RANGE QUERY FOR THE SCORE
```promql
# Peak score over a window (instant queries miss the single-cycle spike).
# Query as a RANGE over the last 15 min, step 30s, with UTC start/end timestamps.
anomaly_detector:score{alias="5g-registered-subscribers"}

# Current value vs learned band:
anomaly_detector:value{alias="5g-registered-subscribers"}
anomaly_detector:lower_band{alias="5g-registered-subscribers"}
anomaly_detector:upper_band{alias="5g-registered-subscribers"}
```
> **Gotcha:** AMP range queries require **UTC** start/end timestamps. Local-time values return empty.

### Step 2: Identify WHICH AMF is affected
```promql
fivegs_amffunction_rm_registeredsubnbr
# Expected during fault: AMF1=0, AMF2=500 (normally 500 each)
```

### Step 3: Check infra health of the affected AMF
```promql
kube_pod_container_status_restarts_total{namespace="open5gs", pod=~"amf1.*"}    # climbing = crash loop
kube_pod_status_phase{namespace="open5gs", pod=~"amf1.*"}
kube_pod_container_status_waiting_reason{namespace="open5gs", pod=~"amf1.*"}    # CrashLoopBackOff
```

### Step 4: Rule out node issues
```promql
kube_node_spec_unschedulable
kube_node_status_condition{condition="Ready"}
```

### Step 5: Determine root cause
```promql
kube_pod_container_status_last_terminated_reason{namespace="open5gs", pod=~"amf1.*"}   # Error, exit 255
```

### Agent Conclusion Template
> "RCF anomaly detected: registered subscribers dropped from 1000 to ~500 (peak score 1.0).
> Root cause: AMF1 in CrashLoopBackOff (N restarts, exit 255) after an amf1-config change that
> removed the required `time.t3512` field. Blast radius: TAC=1 (~500 UEs); AMF2/TAC=2 healthy.
> Recommendation: roll back the amf1-config ConfigMap."

---

## Verify User-Plane Traffic (Data Plane)

```promql
# PDU sessions per UPF (expect 250 each = 1000 total):
fivegs_upffunction_upf_sessionnbr

# Real throughput — use container network bytes (cAdvisor → AMP):
sum by (pod) (rate(container_network_receive_bytes_total{namespace="open5gs", pod=~"upf.*"}[2m])
            + rate(container_network_transmit_bytes_total{namespace="open5gs", pod=~"upf.*"}[2m]))
```
> **Note:** open5gs 2.6.6 exports `fivegs_ep_n3_gtp_indatapktn3upf` / `outdatapktn3upf` but they do **not**
> increment in the data path (build limitation). Use `container_network_*_bytes_total` for throughput.
> The UPF `ogstun` device is brought up by a postStart hook (`manifests/patch-upf-ogstun.sh`) because
> running `open5gs-upfd` with a custom command bypasses the image entrypoint that normally configures it.

---

## AMP Resources

| Resource | ID |
|---|---|
| Workspace | `YOUR_AMP_WORKSPACE_ID` |
| RCF Detector alias | `5g-registered-subscribers` |
| Alert Rule NS | `rcf-anomaly-alerts` |
| Alert name | `RCF5GRegistrationDrop` (score > 0.1) |
