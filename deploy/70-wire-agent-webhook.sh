#!/usr/bin/env bash
# Wire the (human-created) DevOps Agent Space webhook into the RCA bridge Lambda.
#
# Prereqs:
#   1. `cdk deploy Open5gsAmpStack` has run (the Secrets Manager secret + Lambda exist).
#   2. You created the DevOps Agent Space in the console and have its webhook URL + auth token.
#
# What it does: writes {"url","token"} into the Secrets Manager secret that the forwarder Lambda
# reads at runtime. Re-run anytime to rotate. The token is entered hidden and passed via a
# 0600 temp file, so it never lands in shell history or the process list (argv).
#
# Usage:  ./deploy/70-wire-agent-webhook.sh
set -euo pipefail

: "${AWS_PROFILE:=default}"
export AWS_PROFILE
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-Open5gsAmpStack}"
SECRET_ID="open5gs/devops-agent/webhook"
LAMBDA="open5gs-rcf-rca"

# Fail early if the secret isn't there yet.
aws secretsmanager describe-secret --secret-id "$SECRET_ID" --region "$REGION" >/dev/null 2>&1 \
  || { echo "ERROR: secret '$SECRET_ID' not found. Run 'cdk deploy $STACK' first."; exit 1; }

# Resolve the RCA SNS topic (for the optional test) from the stack outputs.
TOPIC=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='RcaTopicArn'].OutputValue" --output text 2>/dev/null || true)

# Collect values — token hidden, nothing enters shell history.
read -rp  "DevOps Agent webhook URL:   " URL
read -rsp "DevOps Agent webhook token: " TOKEN; echo
[[ "$URL" == https://* ]] || { echo "ERROR: URL must start with https://"; exit 1; }
[[ -n "$TOKEN" ]]         || { echo "ERROR: token must not be empty"; exit 1; }

# Write via a 0600 temp file so the token never appears in argv / 'ps'.
TMP=$(mktemp); chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
printf '{"url":"%s","token":"%s"}' "$URL" "$TOKEN" > "$TMP"
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --secret-string "file://$TMP" --query 'VersionId' --output text >/dev/null
echo "✓ Secret '$SECRET_ID' updated (Lambda picks it up on the next alert; no redeploy)."

# Optional: fire a synthetic alert through the real pipeline and check the POST result.
read -rp "Run a test alert through the pipeline now? [y/N] " YN
if [[ "${YN:-N}" =~ ^[Yy]$ ]]; then
  if [[ -z "$TOPIC" ]]; then echo "Could not resolve RcaTopicArn from stack outputs; skipping test."; exit 0; fi
  aws sns publish --topic-arn "$TOPIC" --region "$REGION" \
    --subject "RCF 5G registration anomaly (test)" \
    --message '{"alertname":"RCF5GRegistrationDrop","status":"firing","alias":"5g-registered-subscribers"}' \
    --query MessageId --output text >/dev/null
  echo "Published test alert; waiting 20s for the Lambda..."
  sleep 20
  START=$(( ($(date +%s) - 120) * 1000 ))
  echo "─── webhook result from Lambda logs ───"
  aws logs filter-log-events --log-group-name "/aws/lambda/${LAMBDA}" \
    --start-time "$START" --region "$REGION" \
    --query 'events[].message' --output text 2>/dev/null \
    | tr '\t' '\n' | grep -aiE "Agent webhook status|webhook POST failed|not configured" | tail -3 \
    || echo "  (no webhook log line yet; check CloudWatch /aws/lambda/${LAMBDA})"
fi
echo "Done."
