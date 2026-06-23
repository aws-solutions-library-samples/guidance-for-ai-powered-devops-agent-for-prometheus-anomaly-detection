# 5G Anomaly Detection with AWS Managed Prometheus

Detect 5G network anomalies using **RCF (Random Cut Forest)** on Amazon Managed Prometheus. A live open5gs 5G core on EKS generates real registration/session metrics; RCF learns the baseline and fires when infrastructure faults cause subscriber drops.

## What It Does

```
100 UEs → 4 gNBs → 2 AMFs → SMF → UPF (open5gs on EKS)
                      ↓ metrics
              Amazon Managed Prometheus (AMP)
                      ↓ RCF anomaly detection
              Score spikes when subscribers drop
                      ↓
              DevOps Agent investigates via Prometheus MCP
```

**Demo scenario**: A bad config push crashes AMF1 → 50 users lose registration → RCF detects → correlate with pod restarts to find root cause.

## Deploy (4 steps)

### Prerequisites
- AWS CLI configured with a profile (account with EKS, AMP, SageMaker permissions)
- Node.js 18+, CDK CLI (`npm install -g aws-cdk`)
- kubectl, eksctl, Helm 3

### 1. Deploy CDK (AMP + MCP + Notebook)
```bash
export AWS_PROFILE=your-profile
cd cdk && npm install
cdk bootstrap
cdk deploy --all --require-approval never
```

Creates: AMP workspace, RCF anomaly detector, alert rules, Prometheus MCP (Lambda/API GW/Cognito), SageMaker Notebook.

### 2. Deploy EKS + Prometheus
```bash
./deploy/30-eks-open5gs.sh
```

Creates: EKS cluster (3 nodes), kube-prometheus-stack with remote_write to AMP.

### 3. Deploy 5G Core + 100 UEs
```bash
./deploy/50-open5gs.sh
```

Creates: open5gs NFs (2 AMFs, 4 UPFs, shared CP), 100 UERANSIM UEs, provisions subscribers.

### 4. Open the Demo Notebook
Go to **SageMaker → Notebook Instances → open5gs-rcf-anomaly-demo → Open Jupyter**

Run `rcf-anomaly-detection-demo.ipynb` — it walks through:
1. Verify baseline (100 UEs registered, RCF score = 0)
2. Inject fault (bad config → AMF1 crashes)
3. Observe anomaly (RCF score spikes, 50 users drop)
4. Root cause analysis (correlate with pod restarts)
5. Recovery (fix config → users re-register)

## Quick Fault Injection (CLI)

```bash
# Break AMF1 (50 users lose service)
./manifests/fault-inject-amf1.sh break

# Check RCF score via Prometheus MCP
# anomaly_detector:score{alias="5g-registered-subscribers"} > 0.1

# Fix it
./manifests/fault-inject-amf1.sh fix
```

## Architecture

| Layer | Components |
|---|---|
| **RAN** | 4 gNBs (UERANSIM StatefulSets, 25 UEs each) |
| **Core** | 2 AMFs (TAC partitioned), SMF, 4 UPFs, NRF/AUSF/UDM/UDR/PCF/NSSF/BSF |
| **Monitoring** | kube-prometheus-stack → remote_write (SigV4/IRSA) → AMP |
| **Detection** | RCF anomaly detector on `sum(fivegs_amffunction_rm_registeredsubnbr)` |
| **Access** | Prometheus MCP (OAuth2/API GW) for DevOps Agent; SageMaker Notebook for humans |

## Teardown

```bash
kubectl delete -f manifests/ueransim-multi.yaml
kubectl delete -f manifests/open5gs-core-multi.yaml
eksctl delete cluster -f /tmp/amp-cluster/cluster.yaml
cd cdk && cdk destroy --all
```

## Docs
- [`docs/CONTEXT.md`](docs/CONTEXT.md) — live resource IDs, critical fixes, resume checklist
- [`docs/DEMO-RUNBOOK.md`](docs/DEMO-RUNBOOK.md) — step-by-step demo with correlation queries
- [`setup_guide.md`](setup_guide.md) — detailed deploy/verify/troubleshoot guide
