# Threat Model: Guidance for 5G Network Anomaly Detection and Automated Root-Cause Analysis

**Author:** Mohamed Sherif (mdsherif)
**Date:** 2026-08-17
**BuilderSpace:** https://builderspace.aws.dev/project/9797c2a7-3823-4c92-ae32-7c6314d82234
**Repo:** https://github.com/aws-solutions-library-samples/guidance-for-ai-powered-devops-agent-for-prometheus-anomaly-detection

---

## 1. What are we building?

A sample code Guidance that demonstrates anomaly detection on a 5G mobile core network using Amazon Managed Prometheus (AMP) Random Cut Forest (RCF), with automated root-cause analysis via the AWS DevOps Agent.

### Components

| Component | Technology | Security Details |
|---|---|---|
| 5G Core (demo workload) | open5gs on Amazon EKS (private subnets) | Pods in open5gs namespace; no public endpoints; metrics on port 9090 (ClusterIP only) |
| RAN Simulator | UERANSIM on Amazon EKS | Internal only; simulates UEs for metric generation |
| Metric Pipeline | kube-prometheus-stack remote-writing to AMP | IRSA (amp-prometheus SA) with AmazonPrometheusRemoteWriteAccess; SigV4 authentication |
| Anomaly Detection | AMP RCF detector + alert rules | Managed service; evaluates sum(registered subscribers) every 30s |
| Alert Forwarding | AMP Alertmanager, SNS, Lambda | SNS topic policy scoped to AMP workspace ARN + account; Lambda reads webhook from Secrets Manager |
| Prometheus MCP (agent query path) | Lambda + API Gateway + Cognito | OAuth2 client-credentials flow; JWT authorizer validates Cognito tokens; scoped to prometheus-mcp-server/read |
| Webhook Secret | AWS Secrets Manager | Stores DevOps Agent webhook URL + token; read at runtime by forwarder Lambda; never in CDK/CloudFormation |
| Demo Notebook | Amazon SageMaker | Notebook instance with IAM role; EKS access via access entry (not RBAC); optional VPC attachment |

### Data Classification

- **Metrics data:** Synthetic 5G subscriber counts (not real customer data)
- **Secrets:** Webhook token (Secrets Manager), Cognito client secret (Cognito-managed), IRSA credentials (STS-managed)
- **No customer content:** This is a demo workload; no real subscriber data or PII

### Network Architecture

- EKS worker nodes: private subnets with NAT gateway egress
- EKS API server: public endpoint with optional CIDR restriction
- API Gateway MCP endpoint: public (internet-facing), JWT-authorized
- SNS topic: enforceSSL=true
- No LoadBalancer Services exposed to the internet

---

## 2. What can go wrong?

| Threat | Component | Severity | Description |
|---|---|---|---|
| T1: Unauthorized metric query | API Gateway /mcp | HIGH | Attacker obtains or brute-forces OAuth2 credentials to query AMP metrics |
| T2: Webhook secret exposure | Secrets Manager / Lambda env | HIGH | Webhook token leaked via logs, CloudFormation, or code; allows attacker to inject fake incidents |
| T3: IAM over-permissioning | Lambda roles, EKS SA | MEDIUM | Overly broad policies allow lateral movement from a compromised Lambda |
| T4: Container supply chain | open5gs, UERANSIM, MongoDB images | MEDIUM | Malicious or vulnerable third-party container images |
| T5: SNS topic abuse | SNS topic | LOW | Unauthorized publish to the alert topic triggers spurious agent investigations |
| T6: EKS control plane access | EKS API server | MEDIUM | Unauthorized kubectl access to the cluster |
| T7: SageMaker notebook data exfil | Notebook instance | LOW | Notebook has broad IAM; could be used to exfiltrate data |
| T8: Denial of service on MCP | API Gateway | LOW | Excessive requests to the /mcp endpoint exhaust Lambda concurrency |

---

## 3. What can we do about it?

| Threat | Mitigation | Implementation |
|---|---|---|
| T1 | OAuth2 with Cognito M2M client-credentials | JWT authorizer validates signature, issuer, expiry, and required scope (prometheus-mcp-server/read). No user pool users exist; only holders of client_id + client_secret can obtain a token. |
| T2 | Secrets Manager with runtime-only reads | Webhook token is never in CDK/CloudFormation parameters or environment variables at synth time. Lambda reads it fresh per invocation. deploy/70 writes via 0600 temp file (no shell history). The secret value is shown only once in the Agent Space console. |
| T3 | Least-privilege IAM enforced by cdk-nag | AwsSolutionsChecks runs on every synth. Lambda roles are scoped: forwarder has only secretsmanager:GetSecretValue on one secret; MCP Lambda has only aps:QueryMetrics/ListSeries/GetLabels/GetMetricMetadata on the workspace ARN. All suppressions are documented with justification. |
| T4 | Third-party images documented; not redistributed | NOTICE.md lists all third-party components with licenses. Images are pulled at deploy time from public registries; customers should mirror to private ECR for production. No images are bundled in the repo. |
| T5 | SNS topic policy scoped to AMP workspace ARN | Only the specific AMP workspace (ArnEquals condition) in the same account (StringEquals aws:SourceAccount) can publish. enforceSSL=true prevents non-TLS publishes. |
| T6 | EKS access entries (not open RBAC) | Notebook role uses EKS access entry with AmazonEKSClusterAdminPolicy scoped to the cluster. No wildcard RBAC bindings. Public endpoint can be CIDR-restricted. |
| T7 | Notebook is a demo tool, not production | SageMaker role has AmazonSageMakerFullAccess (standard managed policy). Notebook is optional and intended for interactive demo only. deploy/60 VPC-attaches it to the private subnet when EKS exists. |
| T8 | API Gateway throttling + Lambda concurrency | Default API Gateway throttling applies. The endpoint is M2M-only (requires valid Cognito token). WAF is not added (cdk-nag suppressed with justification: JWT auth + no public users). |

### Static Analysis Results

| Tool | Status |
|---|---|
| cdk-nag (AwsSolutionsChecks) | Passes with 12 documented suppressions (all with written justification in lambda-app.ts) |
| checkov | Run on CDK output; findings documented in docs/security/checkov-findings.json |
| git-secrets | No secrets found in repo |
| Dependabot | 6 remaining alerts (transitive CDK build-time deps, not deployed to runtime) |

---

## 4. Did we do a good enough job?

**Yes, for a sample code Guidance.** Rationale:

1. **No customer data at risk.** The workload is entirely synthetic (simulated 5G subscribers). No PII, no real telco data, no production traffic.

2. **Authentication on every external-facing path.** The only internet-reachable endpoint (/mcp) requires a valid Cognito JWT. The /health endpoint is public but returns only a static string with no data.

3. **Secrets never flow through infrastructure-as-code.** The webhook token is operator-generated in the Agent Space console, pasted into the notebook cell (or CLI script), and written directly to Secrets Manager. It never appears in CloudFormation templates, CDK context, or Lambda environment variables.

4. **Least-privilege enforced by tooling.** cdk-nag AwsSolutionsChecks validates every synth. Suppressions are centralized in lambda-app.ts with written justification per rule. A reviewer can audit all accepted risks in one place.

5. **Third-party supply chain is documented and scoped.** Open5GS/UERANSIM/MongoDB are demo workloads that generate the telemetry. They're not required by the detection pattern itself. Customers can substitute any Prometheus-compatible metric source. NOTICE.md provides full attribution and licensing guidance.

6. **Defense in depth.** Even if the Cognito client secret were compromised, the attacker gains read-only access to synthetic 5G metrics (not production data). The SNS topic only accepts publishes from the AMP workspace. The forwarder Lambda only forwards; it cannot modify the cluster or query metrics.

### Residual Risks (accepted)

| Risk | Justification |
|---|---|
| Third-party container vulnerabilities | Demo workload; customers should scan/mirror images for production use. Documented in NOTICE.md. |
| npm transitive deps (brace-expansion, fast-uri) | Build-time only (CDK CLI toolchain). Not deployed to Lambda runtime. Cannot fix until aws-cdk-lib patches upstream. |
| No WAF on API Gateway | M2M endpoint with JWT auth; no public users. WAF adds cost without security benefit for this pattern. Documented in cdk-nag suppression. |
| SageMaker notebook has broad IAM | Standard managed policy for demo notebook. Optional component; deploy/60 VPC-attaches it for private access. |

---

## Appendix: Security Controls Summary

| Control | Implemented |
|---|---|
| Encryption in transit (TLS) | Yes: HTTPS on API GW, SigV4 on AMP, enforceSSL on SNS |
| Encryption at rest | Yes: Secrets Manager (KMS), EBS gp3 (encrypted=true), AMP (managed encryption) |
| Authentication | Yes: Cognito OAuth2 (MCP), IRSA/SigV4 (AMP), Secrets Manager (webhook) |
| Authorization | Yes: IAM least-privilege, EKS access entries, JWT scope validation |
| Logging | Yes: CloudWatch Logs on all Lambdas, EKS audit/authenticator/controllerManager |
| Static analysis | Yes: cdk-nag, checkov, git-secrets, Dependabot |
| Secrets management | Yes: Secrets Manager (runtime read), no hardcoded credentials |
| Network isolation | Yes: EKS private subnets, NAT egress, no public LoadBalancers |
