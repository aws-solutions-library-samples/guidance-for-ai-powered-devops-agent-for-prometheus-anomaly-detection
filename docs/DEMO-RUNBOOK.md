# RCF Anomaly Detection Demo Runbook

## Scenario: Bad Config Push → AMF1 CrashLoop → 39 Users Impacted

### Architecture
```
100 UEs → 4 gNBs → 2 AMFs (TAC partitioned) → 1 SMF → 4 UPFs
                      │
                 AMF1 (TAC=1, 39 UEs)  ← FAULT INJECTED HERE
                 AMF2 (TAC=2, 41 UEs)  ← UNAFFECTED
```

### RCF Detector
- **ID**: `ad-a711daf7-2845-4ccb-889f-01220f3021fa`
- **Alias**: `5g-registered-subscribers`
- **Query**: `sum(fivegs_amffunction_rm_registeredsubnbr)`
- **Eval interval**: 30s
- **Training window**: 256 × 30s = 2.1 hours
- **Alert threshold**: score > 0.1, for: 0s

### Timeline

| Time | Event | Metric |
|---|---|---|
| T-2h | RCF learns baseline (~80 registered) | score = 0.0 |
| T+0 | `./manifests/fault-inject-amf1.sh break` | — |
| T+5s | AMF1 crashes (CrashLoopBackOff) | `restarts_total` +1 |
| T+10s | 39 UEs on AMF1 deregister | `registeredsubnbr`: 80→41 |
| T+30s | RCF evaluates | score > 0.1 (anomaly detected) |
| T+30s | Alert fires | `RCF5GRegistrationDrop` FIRING |
| T+2-3m | RCF adapts to new level | score → 0.0 |
| T+Xm | `./manifests/fault-inject-amf1.sh fix` | AMF1 recovers |
| T+X+30s | 39 UEs re-register | `registeredsubnbr`: 41→80 |

---

## Run the Demo

### Prerequisites
```bash
aws eks update-kubeconfig --region us-east-1 --name open5gs-amp-cluster
export AWS_PROFILE=proactive-rca-demo
```

### 1. Verify baseline (before fault)
```bash
# Via Prometheus MCP or awscurl:
# sum(fivegs_amffunction_rm_registeredsubnbr) should be ~80
./manifests/fault-inject-amf1.sh status
```

### 2. Inject fault
```bash
./manifests/fault-inject-amf1.sh break
```

### 3. Watch the drop (within 30s)
```bash
# Check AMF1 crashing
kubectl get pods -n open5gs -l app=amf1 -w

# Check RCF score via Prometheus MCP
# Query: anomaly_detector:score{alias="5g-registered-subscribers"}
```

### 4. Recover
```bash
./manifests/fault-inject-amf1.sh fix
```

---

## DevOps Agent Correlation Queries

When the RCF fires, the DevOps Agent should query these metrics to identify root cause:

### Step 1: Confirm the anomaly
```promql
# What triggered?
anomaly_detector:score{alias="5g-registered-subscribers"}

# What's the current value vs expected?
anomaly_detector:value{alias="5g-registered-subscribers"}
anomaly_detector:lower_band{alias="5g-registered-subscribers"}
anomaly_detector:upper_band{alias="5g-registered-subscribers"}
```

### Step 2: Identify WHICH AMF is affected
```promql
# Per-AMF breakdown — which one dropped?
fivegs_amffunction_rm_registeredsubnbr

# Expected: AMF1=0, AMF2=41 (normally AMF1=39, AMF2=41)
```

### Step 3: Check infra health of the affected AMF
```promql
# Pod restarts (CrashLoopBackOff signal)
kube_pod_container_status_restarts_total{namespace="open5gs", pod=~"amf1.*"}

# Pod phase (not Running = problem)
kube_pod_status_phase{namespace="open5gs", pod=~"amf1.*"}

# Container waiting reason (will show CrashLoopBackOff)
kube_pod_container_status_waiting_reason{namespace="open5gs", pod=~"amf1.*"}
```

### Step 4: Rule out node issues
```promql
# Are nodes healthy?
kube_node_spec_unschedulable

# Node conditions
kube_node_status_condition{condition="Ready"}
```

### Step 5: Determine root cause
```promql
# Last terminated reason (if OOM: reason=OOMKilled)
kube_pod_container_status_last_terminated_reason{namespace="open5gs", pod=~"amf1.*"}

# SCP load (would spike if mass re-registration happening)
rate(container_cpu_usage_seconds_total{namespace="open5gs", pod=~"scp.*"}[5m])
```

### Agent Conclusion Template
> "RCF anomaly detected: registered subscribers dropped from ~80 to ~41.
> Root cause: AMF1 pod is in CrashLoopBackOff (X restarts in Y minutes).
> AMF2 is healthy with 41 UEs still registered.
> Likely cause: configuration change to AMF1 introduced an error.
> Recommendation: Review recent ConfigMap changes to amf1-config and rollback."

---

## AMP Resources

| Resource | ID |
|---|---|
| Workspace | `ws-185ff7f8-c698-4d0e-9135-945b03aeccd1` |
| RCF Detector | `ad-a711daf7-2845-4ccb-889f-01220f3021fa` |
| Alert Rule NS | `rcf-anomaly-alerts` |
| Alert name | `RCF5GRegistrationDrop` |
