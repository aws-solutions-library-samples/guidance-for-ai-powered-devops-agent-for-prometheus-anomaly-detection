"""
Automated RCA bridge for the RCF 5G registration-drop alert (demo scenario 2b).

Flow:  AMP RCF alert (RCF5GRegistrationDrop) -> AMP Alertmanager -> SNS -> this Lambda.

On invocation it runs the same correlation an operator would (per-AMF registration +
AMF pod restarts, queried from AMP via SigV4), derives a root-cause summary, logs it,
and — if a DevOps Agent webhook is configured — POSTs an incident payload to it.

Webhook config (runtime lookup, no redeploy needed):
  1. Secrets Manager secret (AGENT_WEBHOOK_SECRET_ARN) holding JSON {"url","token"} — preferred.
     A human fills this in AFTER creating the Agent Space (console or deploy/70-wire-agent-webhook.sh);
     the value never flows through CDK.
  2. DEVOPS_AGENT_WEBHOOK_URL env var — fallback (no auth token).
Dependency-free: uses the boto3/botocore + urllib bundled in the Lambda runtime.
"""
import json
import os
import urllib.request
import urllib.parse

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

REGION = os.environ.get("AWS_REGION", "us-east-1")
WSID = os.environ["AMP_WORKSPACE_ID"]
AMP_URL = f"https://aps-workspaces.{REGION}.amazonaws.com/workspaces/{WSID}/api/v1/query"
SECRET_ARN = os.environ.get("AGENT_WEBHOOK_SECRET_ARN", "")
AGENT_WEBHOOK_ENV = os.environ.get("DEVOPS_AGENT_WEBHOOK_URL", "")  # fallback, no token

_session = boto3.Session()
_secrets = boto3.client("secretsmanager", region_name=REGION)


def query_amp(promql):
    """Run an instant PromQL query against AMP, signed with SigV4."""
    creds = _session.get_credentials().get_frozen_credentials()
    data = urllib.parse.urlencode({"query": promql}).encode()
    signed = AWSRequest(
        method="POST",
        url=AMP_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    SigV4Auth(creds, "aps", REGION).add_auth(signed)
    req = urllib.request.Request(AMP_URL, data=data, headers=dict(signed.headers), method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())["data"]["result"]


def get_webhook():
    """Return (url, token). Prefer the Secrets Manager secret; fall back to the env var.

    Read fresh each invocation so a rotated secret takes effect without redeploy
    (alerts are low-frequency, so the extra GetSecretValue is negligible).
    """
    if SECRET_ARN:
        try:
            raw = _secrets.get_secret_value(SecretId=SECRET_ARN).get("SecretString", "")
            data = json.loads(raw) if raw else {}
            url = (data.get("url") or "").strip()
            token = (data.get("token") or "").strip()
            if url:
                return url, token
        except Exception as e:  # noqa: BLE001
            print("WARN: could not read webhook secret:", str(e))
    return AGENT_WEBHOOK_ENV.strip(), ""


def handler(event, context):
    print("TRIGGER event:", json.dumps(event)[:800])
    report = {"trigger": "RCF5GRegistrationDrop", "findings": {}}
    try:
        per_amf = query_amp("fivegs_amffunction_rm_registeredsubnbr")
        total = query_amp("sum(fivegs_amffunction_rm_registeredsubnbr)")
        amf = {r["metric"].get("pod", "?"): int(float(r["value"][1])) for r in per_amf}
        total_val = int(float(total[0]["value"][1])) if total else 0
        restarts = query_amp(
            'max by (pod) (kube_pod_container_status_restarts_total'
            '{namespace="open5gs", pod=~"amf.*"})'
        )
        rst = {r["metric"].get("pod", "?"): int(float(r["value"][1])) for r in restarts}
        reporting = set(amf) | set(rst)
        affected = [p for p in reporting if amf.get(p, 0) == 0]
        crashing = [p for p, c in rst.items() if c > 2]
        report["findings"] = {
            "total_registered": total_val,
            "per_amf": amf,
            "amf_restarts": rst,
            "affected_amfs": affected,
            "crashing_amfs": crashing,
        }
        report["root_cause"] = (
            f"Registration = {total_val}. Affected AMF(s): {affected or 'n/a'}. "
            f"CrashLoop AMF(s): {crashing or 'none'}. Likely a bad config push to the "
            "affected AMF (CrashLoopBackOff) -> roll back its ConfigMap."
        )
    except Exception as e:  # noqa: BLE001 - report any query failure, don't crash the trigger
        report["error"] = str(e)

    print("RCA_REPORT:", json.dumps(report, indent=2))

    url, token = get_webhook()
    if url:
        try:
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            payload = json.dumps({
                "eventType": "incident",
                "incidentId": "RCF5GRegistrationDrop",
                "action": "created",
                "priority": "HIGH",
                "title": "5G registration anomaly (RCF)",
                "description": report.get("root_cause", ""),
                "service": "open5gs-amf",
                "data": {"metadata": report.get("findings", {})},
            }).encode()
            wr = urllib.request.Request(url, data=payload, headers=headers, method="POST")
            with urllib.request.urlopen(wr, timeout=15) as resp:
                print("Agent webhook status:", resp.status)
        except Exception as e:  # noqa: BLE001
            print("Agent webhook POST failed:", str(e))
    else:
        print("NOTE: agent webhook not configured (secret empty + env unset) -> RCA logged only. "
              "Fill the Secrets Manager secret via deploy/70-wire-agent-webhook.sh to auto-forward.")

    return {"statusCode": 200}
