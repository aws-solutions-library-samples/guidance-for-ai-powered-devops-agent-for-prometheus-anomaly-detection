# AI-Powered DevOps Agent for Prometheus Anomaly Detection

The **AWS DevOps Agent** performing anomaly detection on **5G telco metrics** via **Amazon Managed
Prometheus (AMP)**. A real open5gs 5G core + UERANSIM (on EKS) emit live registration/session metrics;
they land in AMP and are queryable by the DevOps Agent through the awslabs **Prometheus MCP server**.

```
open5gs NFs (AMF/SMF/UPF) --/metrics--> kube-prometheus-stack
   --remote_write (SigV4/IRSA)--> AMP workspace
   <--SigV4-- Prometheus MCP (Lambda) <--OAuth2 / API Gateway-- AWS DevOps Agent
```

## 📖 Start here
- **[`docs/CONTEXT.md`](docs/CONTEXT.md)** — full state, live resource IDs, fixes applied, resume checklist (read first).
- **[`setup_guide.md`](setup_guide.md)** — deploy from scratch + verify + troubleshoot + teardown.
- **[`docs/diagrams/architecture.svg`](docs/diagrams/architecture.svg)** — architecture diagram.

## Status (2026-06-23)
✅ End-to-end proven with **live 5G data**: open5gs core (pod-network, no Multus) + UERANSIM UE
registers and establishes a PDU session; `fivegs_amffunction_*` (registration) and
`fivegs_smffunction_*` (sessions) metrics flow to AMP and are queryable via the DevOps Agent MCP.

## Quick deploy
```bash
export AWS_PROFILE=proactive-rca-demo            # account 985090322243, us-east-1
cd cdk && ../deploy/10-deploy-cdk.sh             # AMP + Prometheus MCP (Cognito/Lambda/APIGW)
./deploy/20-register-agent.sh                    # register MCP with DevOps Agent (register-only)
./deploy/30-eks-open5gs.sh                       # EKS + Prometheus agent remote_write -> AMP
./deploy/50-open5gs.sh                           # open5gs core + UERANSIM + 5G metrics
```

## Layout
| Path | Purpose |
|---|---|
| `cdk/` | AMP workspace + vendored Prometheus MCP (Cognito/Lambda/API GW) + register-only connectivity |
| `deploy/` | Ordered deploy scripts `10`→`50` + `40-verify-amp.sh` |
| `helm/open5gs-amp/` | kube-prometheus-stack values (remote_write to AMP via IRSA) |
| `manifests/` | `open5gs-core.yaml`, `open5gs-scrape.yaml`, `ueransim.yaml`, `provision-subscriber.sh` |
| `docs/` | `CONTEXT.md`, diagrams |

## Security
No public dashboards. The only public surface is the **OAuth2-authenticated API Gateway** MCP endpoint.
Prometheus/Grafana are ClusterIP only. See `~/.kiro/steering/aws-security-guardrails.md`.
