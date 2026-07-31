"""
Automated RCA bridge for the RCF 5G registration-drop alert (demo scenario 2b).

Flow:  AMP RCF alert (RCF5GRegistrationDrop) -> AMP Alertmanager -> SNS -> this Lambda.

On invocation it runs the same correlation an operator would (per-AMF registration +
AMF pod restarts, queried from AMP via SigV4), derives a root-cause summary, logs it,
and — if DEVOPS_AGENT_WEBHOOK_URL is set — POSTs an incident payload to the AWS DevOps
Agent webhook. Dependency-free: uses the botocore + urllib bundled in the Lambda runtime.
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
AGENT_WEBHOOK = os.environ.get("DEVOPS_AGENT_WEBHOOK_URL", "")

_session = boto3.Session()


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

    if AGENT_WEBHOOK:
        try:
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
            wr = urllib.request.Request(
                AGENT_WEBHOOK, data=payload,
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(wr, timeout=15) as resp:
                print("Agent webhook status:", resp.status)
        except Exception as e:  # noqa: BLE001
            print("Agent webhook POST failed:", str(e))
    else:
        print("NOTE: DEVOPS_AGENT_WEBHOOK_URL not set -> RCA logged only. "
              "Set it to auto-forward to the DevOps Agent.")

    return {"statusCode": 200}
