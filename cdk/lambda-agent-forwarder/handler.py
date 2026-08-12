"""
Trigger bridge for the RCF 5G registration-drop alert.

Flow:  AMP RCF alert (RCF5GRegistrationDrop) -> AMP Alertmanager -> SNS -> this Lambda.

This Lambda is a PURE webhook forwarder. It reads the alert from SNS and POSTs an
incident to the AWS DevOps Agent webhook; the DevOps Agent then performs the ENTIRE
autonomous investigation (querying Amazon Managed Service for Prometheus, Amazon EKS,
etc.). The Lambda does NOT query metrics or derive root cause itself.

Webhook config (runtime lookup, no redeploy needed):
  Secrets Manager secret (AGENT_WEBHOOK_SECRET_ARN) holding JSON {"url","token","auth"}.
    "auth" is "hmac" (x-amzn-event-signature) or "bearer" (Authorization: Bearer).
  DEVOPS_AGENT_WEBHOOK_URL env var is an optional fallback (no auth token).
Dependency-free: uses the boto3 + urllib bundled in the Lambda runtime.
"""
import base64
import hashlib
import hmac
import json
import os
import urllib.request
from datetime import datetime, timezone

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
SECRET_ARN = os.environ.get("AGENT_WEBHOOK_SECRET_ARN", "")
AGENT_WEBHOOK_ENV = os.environ.get("DEVOPS_AGENT_WEBHOOK_URL", "")  # fallback, no token

_secrets = boto3.client("secretsmanager", region_name=REGION)


def get_webhook():
    """Return (url, token, auth). Prefer the Secrets Manager secret; fall back to the env var.

    Read fresh each invocation so a rotated secret takes effect without redeploy.
    'auth' is "hmac" (sign with x-amzn-event-signature) or "bearer" (Authorization: Bearer).
    """
    if SECRET_ARN:
        try:
            raw = _secrets.get_secret_value(SecretId=SECRET_ARN).get("SecretString", "")
            data = json.loads(raw) if raw else {}
            url = (data.get("url") or "").strip()
            token = (data.get("token") or "").strip()
            auth = (data.get("auth") or "").strip().lower()
            if url:
                return url, token, auth
        except Exception as e:  # noqa: BLE001
            print("WARN: could not read webhook secret:", str(e))
    return AGENT_WEBHOOK_ENV.strip(), "", ""


def alert_summary(event):
    """Best-effort short description from the SNS/Alertmanager message.

    We only forward what the alert carries; we do NOT query metrics. If the payload
    can't be parsed we fall back to a generic description and let the agent investigate.
    """
    try:
        msg = event["Records"][0]["Sns"]["Message"]
        data = json.loads(msg)
        alerts = data.get("alerts") or []
        if alerts:
            a = alerts[0]
            ann = a.get("annotations", {}) or {}
            lbl = a.get("labels", {}) or {}
            return (
                ann.get("summary")
                or ann.get("description")
                or f"{lbl.get('alertname', 'RCF5GRegistrationDrop')} is {a.get('status', 'firing')}."
            )
    except Exception:  # noqa: BLE001
        pass
    return "RCF anomaly detector fired on the 5G registered-subscriber count."


def handler(event, context):
    print("TRIGGER event:", json.dumps(event)[:800])
    summary = alert_summary(event)

    url, token, auth = get_webhook()
    if not url:
        print(
            "NOTE: agent webhook not configured (secret empty + env unset) -> nothing forwarded. "
            "Fill the Secrets Manager secret via the notebook Step 2 wiring cell. Alert: " + summary
        )
        return {"statusCode": 200}

    try:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        # Body is serialized ONCE; the exact same string is what we sign and send.
        body = json.dumps({
            "eventType": "incident",
            "incidentId": "RCF5GRegistrationDrop",
            "action": "created",
            "priority": "HIGH",
            "title": "5G registration anomaly detected (RCF)",
            "description": (
                summary
                + " Investigate the open5gs 5G core on Amazon EKS (cluster "
                "open5gs-amp-cluster, namespace open5gs) to identify the affected network "
                "function and root cause."
            ),
            "timestamp": ts,
            "service": "open5gs-amf",
            "data": {"source": "amp.rcf", "alert": "RCF5GRegistrationDrop"},
        }, separators=(",", ":"))
        headers = {"Content-Type": "application/json"}
        if auth == "hmac":
            # AWS DevOps Agent HMAC: base64(HMAC-SHA256(secret, f"{ts}:{body}"))
            sig = base64.b64encode(
                hmac.new(token.encode("utf-8"), f"{ts}:{body}".encode("utf-8"),
                         hashlib.sha256).digest()
            ).decode()
            headers["x-amzn-event-timestamp"] = ts
            headers["x-amzn-event-signature"] = sig
        elif token:
            headers["Authorization"] = f"Bearer {token}"
        wr = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(wr, timeout=15) as resp:
            print(f"Agent webhook status: {resp.status} (auth={auth or 'bearer/none'}) -> DevOps Agent will investigate.")
    except Exception as e:  # noqa: BLE001
        print("Agent webhook POST failed:", str(e))

    return {"statusCode": 200}
