#!/usr/bin/env python3
"""Generate the improved RCF anomaly-detection demo notebook (1000-UE scale)."""
import json, sys

cells = []
def md(text): cells.append({"cell_type": "markdown", "metadata": {}, "source": text})
def code(text): cells.append({"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": text})

# ---- Title ----
md("""# 5G RCF Anomaly Detection Demo (1000 UEs)

This notebook demonstrates **Amazon Managed Prometheus RCF anomaly detection** on a live 5G core at scale.

**Scale**: `1000 UEs → 100 gNBs → 2 AMFs → SMF → 4 UPFs` (open5gs on EKS), 250 PDU sessions per UPF, continuous user-plane traffic.

**Scenario**: A bad config push to AMF1 crashes it (CrashLoopBackOff), so **~500 of 1000 UEs** lose registration. RCF flags the drop within one 30s evaluation cycle, which **automatically triggers the AWS DevOps Agent** (RCF alert → Alertmanager → SNS → an RCA Lambda → the agent's webhook) to investigate and pinpoint root cause. We then recover.

---
## Architecture
![Architecture](architecture.png)""")

md("""## RCF Data Flow
![RCF Dataflow](rcf-dataflow.png)""")

md("""## Demo Scenario (Before \u2192 Fault \u2192 Recovery)
![Fault Scenario](fault-scenario.png)

---""")

# ---- Setup ----
md("""## Setup

Installs kubectl (if missing), configures kubeconfig, and verifies EKS connectivity.
Defines two AMP query helpers:
- `query_amp(promql)` \u2014 instant query (current value)
- `query_amp_range(promql, minutes)` \u2014 **range query in UTC** (needed to capture the RCF score spike, see Step 3)

> **Lesson:** AMP range queries require **UTC** timestamps. Using local time returns empty results.""")

code('''import boto3, json, time, subprocess, os
from datetime import datetime, timedelta, timezone
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
import requests

# Configuration - self-discovering (no hardcoded account / region / workspace).
# Region comes from the notebook's own environment; the AMP workspace is looked up
# by its alias, so this notebook works unchanged in any account or region.
REGION = os.environ.get('AWS_REGION') or boto3.Session().region_name or 'us-east-1'
EKS_CLUSTER = os.environ.get('EKS_CLUSTER', 'open5gs-amp-cluster')
AMP_WORKSPACE_ALIAS = os.environ.get('AMP_WORKSPACE_ALIAS', 'open5gs-amp')

session = boto3.Session(region_name=REGION)
credentials = session.get_credentials().get_frozen_credentials()

def discover_workspace_id(alias=AMP_WORKSPACE_ALIAS):
    """Resolve the AMP workspace ID by alias (portable across accounts/regions).
    Override with the AMP_WORKSPACE_ID env var if you prefer to pin it."""
    if os.environ.get('AMP_WORKSPACE_ID'):
        return os.environ['AMP_WORKSPACE_ID']
    amp = session.client('amp')
    token = None
    while True:
        resp = amp.list_workspaces(**({'nextToken': token} if token else {}))
        for ws in resp.get('workspaces', []):
            if ws.get('alias') == alias:
                return ws['workspaceId']
        token = resp.get('nextToken')
        if not token:
            break
    raise RuntimeError(f"No AMP workspace with alias '{alias}' in {REGION}. "
                       "Set AMP_WORKSPACE_ID to pin one.")

WORKSPACE_ID = discover_workspace_id()
AMP_QUERY_URL = f'https://aps-workspaces.{REGION}.amazonaws.com/workspaces/{WORKSPACE_ID}/api/v1/query'
AMP_RANGE_URL = AMP_QUERY_URL + '_range'

def query_amp(promql):
    """Instant PromQL query against AMP (SigV4)."""
    params = {'query': promql}
    req = AWSRequest(method='POST', url=AMP_QUERY_URL, data=params)
    SigV4Auth(credentials, 'aps', REGION).add_auth(req)
    resp = requests.post(AMP_QUERY_URL, data=params, headers=dict(req.headers), timeout=30)
    return resp.json()['data']['result']

def query_amp_range(promql, minutes=15, step='30s'):
    """Range PromQL query against AMP over the last N minutes.
    Uses UTC timestamps - AMP returns empty results for local-time queries."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(minutes=minutes)
    params = {'query': promql,
              'start': start.strftime('%Y-%m-%dT%H:%M:%SZ'),
              'end': end.strftime('%Y-%m-%dT%H:%M:%SZ'),
              'step': step}
    req = AWSRequest(method='POST', url=AMP_RANGE_URL, data=params)
    SigV4Auth(credentials, 'aps', REGION).add_auth(req)
    resp = requests.post(AMP_RANGE_URL, data=params, headers=dict(req.headers), timeout=30)
    return resp.json()['data']['result']

def run_kubectl(args, stdin=None, timeout=60):
    """Run kubectl with a timeout. Returns (ok, stdout, stderr). Never hangs."""
    try:
        r = subprocess.run(['kubectl'] + args, input=stdin,
                           capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            print(f'  \u26a0 kubectl {" ".join(args[:2])} failed (rc={r.returncode}): {r.stderr.strip()[:300]}')
        return (r.returncode == 0, r.stdout, r.stderr)
    except subprocess.TimeoutExpired:
        print(f'  \u26a0 kubectl {" ".join(args[:2])} TIMED OUT after {timeout}s')
        print('    \u2192 Likely: notebook IAM role lacks EKS access, or endpoint unreachable.')
        return (False, '', 'timeout')

# Install kubectl if missing
if not os.path.exists('/usr/local/bin/kubectl'):
    print('Installing kubectl...')
    subprocess.run(['curl', '-sLO', 'https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl'], capture_output=True, timeout=120)
    subprocess.run(['chmod', '+x', 'kubectl'], capture_output=True)
    subprocess.run(['sudo', 'mv', 'kubectl', '/usr/local/bin/'], capture_output=True)

subprocess.run(['aws', 'eks', 'update-kubeconfig', '--region', REGION, '--name', EKS_CLUSTER],
               capture_output=True, timeout=60)

print(f'\u2713 AMP workspace: {WORKSPACE_ID}  |  Region: {REGION}  |  EKS: {EKS_CLUSTER}')
ok, out, err = run_kubectl(['get', 'nodes', '--no-headers'], timeout=45)
print(f'\u2713 kubectl connected: {len(out.strip().splitlines())} nodes ready' if ok
      else '\u2717 kubectl NOT connected \u2014 fix EKS access before fault-injection cells.')''')

# ---- Step 1: baseline ----
md("""## Step 1: Verify Baseline (Healthy State)

All **1000 UEs** registered across 2 AMFs (500 each: AMF1=TAC1, AMF2=TAC2). RCF score should be 0.""")

code('''results = query_amp('fivegs_amffunction_rm_registeredsubnbr')
print('\u2550\u2550\u2550 Registered Subscribers (per AMF) \u2550\u2550\u2550')
total = 0
for r in sorted(results, key=lambda x: x['metric'].get('pod','')):
    pod = r['metric'].get('pod', 'unknown')
    value = int(r['value'][1]); total += value
    print(f'  {pod}: {value} UEs')
print('  ' + '\u2500'*30)
print(f'  TOTAL: {total} UEs registered')
print()
rcf = query_amp('{__name__=~"anomaly_detector:.+", alias="5g-registered-subscribers"}')
print('\u2550\u2550\u2550 RCF Anomaly Detector \u2550\u2550\u2550')
for r in sorted(rcf, key=lambda x: x['metric']['__name__']):
    print(f'  {r["metric"]["__name__"].replace("anomaly_detector:",""):12s}: {r["value"][1]}')
print()
print('\u2713 Baseline healthy (1000 UEs)' if total >= 800 else f'\u26a0 Only {total} UEs \u2014 wait for full registration')''')

# ---- Step 1b: user-plane traffic ----
md("""## Step 1b: Verify User-Plane Traffic (Data Plane)

Confirms the 1000 PDU sessions are spread across the 4 UPFs (250 each) and that real GTP-U user-plane
traffic is flowing (the traffic generators ping each DNN gateway).

> **Lesson:** open5gs 2.6.6 exports `fivegs_ep_n3_gtp_*` but they **stay 0** (not wired in the data path).
> Use **`container_network_*_bytes_total`** (cAdvisor \u2192 AMP) for real throughput.""")

code('''print('\u2550\u2550\u2550 PDU Sessions per UPF \u2550\u2550\u2550')
sess_total = 0
for r in sorted(query_amp('fivegs_upffunction_upf_sessionnbr'), key=lambda x: x['metric'].get('pod','')):
    pod = r['metric'].get('pod', '?'); v = int(r['value'][1]); sess_total += v
    print(f'  {pod}: {v} sessions')
print(f'  TOTAL: {sess_total} PDU sessions')
print()
print('\u2550\u2550\u2550 User-Plane Traffic (UPF network throughput) \u2550\u2550\u2550')
rx = query_amp('sum by (pod) (rate(container_network_receive_bytes_total{namespace="open5gs", pod=~"upf.*"}[2m]) + rate(container_network_transmit_bytes_total{namespace="open5gs", pod=~"upf.*"}[2m]))')
tot_kb = 0.0
for r in sorted(rx, key=lambda x: x['metric'].get('pod','')):
    pod = r['metric'].get('pod', '?'); kb = float(r['value'][1]) / 1024.0; tot_kb += kb
    print(f'  {pod}: {kb:6.1f} KB/s')
print(f'  TOTAL: {tot_kb:.1f} KB/s flowing through the user plane')
print()
print('\u2713 Data plane active' if tot_kb > 1 else '\u26a0 No traffic \u2014 check traffic-gen / ogstun on UPFs')''')

# ---- Step 2: set up + wire the DevOps Agent (BEFORE the fault) ----
md("""## Step 2: Set up & Wire the AWS DevOps Agent  (do this BEFORE the fault)

So the anomaly **automatically launches an AI investigation**, wire the DevOps Agent now — before injecting the fault.

**One-time setup in the AWS console:**
1. **Create an Agent Space** — in the AWS DevOps Agent console, create an Agent Space (an isolated workspace with its own account access, users, data, and chat history).
2. **Add the Prometheus MCP capability** — Agent Space → *Capabilities* → add an MCP capability provider pointing at the API Gateway `/mcp` endpoint this project deployed (`https://<api-id>.execute-api.<region>.amazonaws.com/prod/mcp`, OAuth2 client-credentials from the Cognito stack). This lets the agent **query AMP** during its investigation. *(`deploy/20-register-agent.sh` registers this endpoint for you.)*
3. **Generate a webhook** — Agent Space → *Capabilities* → *Webhook* → **Generate webhook**, then pick an auth type:
   - **HMAC** *(recommended)* — each request is signed; verified via the `x-amzn-event-signature` header.
   - **API key** — sent as `Authorization: Bearer <secret>`.
   Copy the **webhook URL** and the **secret** (the secret is shown only once).

Paste those two values into the next cell, set the matching auth type, then run the **wiring cell**. The RCA Lambda (`open5gs-rcf-rca`) reads them from Secrets Manager **at runtime**, so the instant RCF fires it POSTs the incident and the agent starts investigating — no redeploy needed.""")

code('''# \u2500\u2500\u2500 PASTE your DevOps Agent webhook details here \u2500\u2500\u2500
DEVOPS_AGENT_WEBHOOK_URL    = "PASTE_YOUR_WEBHOOK_URL_HERE"
DEVOPS_AGENT_WEBHOOK_SECRET = "PASTE_YOUR_WEBHOOK_SECRET_HERE"
DEVOPS_AGENT_AUTH           = "hmac"   # "hmac" (x-amzn-event-signature) or "bearer" (Authorization: Bearer)
print("Values set. Run the next cell to wire them into Secrets Manager.")''')

code('''# Wire the webhook into the RCA Lambda's Secrets Manager secret (read at runtime -> no redeploy).
import boto3, json as _json
_SECRET_ID = "open5gs/devops-agent/webhook"
if "PASTE_" in DEVOPS_AGENT_WEBHOOK_URL or "PASTE_" in DEVOPS_AGENT_WEBHOOK_SECRET:
    print("\u2717 Fill in the URL and SECRET in the cell above first, then re-run this cell.")
elif DEVOPS_AGENT_AUTH not in ("hmac", "bearer"):
    print('\u2717 DEVOPS_AGENT_AUTH must be "hmac" or "bearer".')
else:
    boto3.client("secretsmanager", region_name=REGION).put_secret_value(
        SecretId=_SECRET_ID,
        SecretString=_json.dumps({"url": DEVOPS_AGENT_WEBHOOK_URL,
                                  "token": DEVOPS_AGENT_WEBHOOK_SECRET,
                                  "auth": DEVOPS_AGENT_AUTH}))
    print(f"\u2713 Webhook wired into Secrets Manager ({_SECRET_ID}), auth={DEVOPS_AGENT_AUTH}.")
    print("  Pipeline armed:  RCF fires \u2192 SNS \u2192 open5gs-rcf-rca Lambda \u2192 POST to your webhook \u2192 DevOps Agent investigates.")''')

# ---- Step 3: fault ----
md("""## Step 3: Inject Fault (Bad Config Push to AMF1)

Pushes a broken config (the required `time.t3512` field is **removed**) to AMF1. open5gs `amfd` fails to
start \u2192 CrashLoopBackOff \u2192 **~500 UEs (TAC=1) deregister**. AMF2 (TAC=2) is unaffected.

The config keeps the working `dev: eth0` advertise + direct-NRF settings, so the ONLY defect is the
missing timer \u2014 a realistic CI/CD config error.""")

code('''# Broken AMF1 config: working dev:eth0 + direct NRF, but missing required time.t3512
broken_config = """sbi:
  server:
    no_tls: true
  client:
    no_tls: true
amf:
  sbi:
    - dev: eth0
      port: 7777
  ngap:
    - addr: 0.0.0.0
  metrics:
    - addr: 0.0.0.0
      port: 9090
  guami:
    - plmn_id: {mcc: 999, mnc: 70}
      amf_id: {region: 2, set: 1}
  tai:
    - plmn_id: {mcc: 999, mnc: 70}
      tac: 1
  plmn_support:
    - plmn_id: {mcc: 999, mnc: 70}
      s_nssai:
        - sst: 1
  security:
    integrity_order: [NIA2, NIA1, NIA0]
    ciphering_order: [NEA0, NEA1, NEA2]
  network_name:
    full: Open5GS
  amf_name: open5gs-amf1
nrf:
  sbi:
    - addr: nrf.open5gs.svc.cluster.local
      port: 7777
"""

print('\u2550\u2550\u2550 FAULT INJECTION \u2550\u2550\u2550')
print('Pushing broken config to AMF1 (missing time.t3512)...')
ok, cm_yaml, _ = run_kubectl(['create', 'configmap', 'amf1-config', '-n', 'open5gs',
     f'--from-literal=amf.yaml={broken_config}', '--dry-run=client', '-o', 'yaml'], timeout=15)
if ok:
    ok2, _, _ = run_kubectl(['apply', '-f', '-'], stdin=cm_yaml, timeout=30)
    if ok2:
        # delete (NOT rollout restart) so the ReplicaSet recreates with the broken config -> crash loop
        run_kubectl(['delete', 'pod', '-n', 'open5gs', '-l', 'app=amf1', '--wait=false'], timeout=30)
        print('\u2717 Bad config pushed + AMF1 pods deleted \u2192 CrashLoopBackOff.')
        print('  ~500 UEs (TAC=1) will deregister within ~30s. Waiting 75s for impact + RCF eval...')
        for _ in range(5):
            time.sleep(15)
            try:
                total = sum(int(float(r['value'][1])) for r in query_amp('fivegs_amffunction_rm_registeredsubnbr'))
                print(f'  registered subscribers: {total}  (expect ~500 once AMF1 is fully down)')
            except Exception as e:
                print(f'  (AMP query retry: {str(e)[:80]})')
    else:
        print('\u2717 Could not apply config \u2014 check kubectl connectivity (Setup cell).')
else:
    print('\u2717 Could not generate config \u2014 check kubectl is installed (Setup cell).')''')

# ---- Step 4: observe ----
md("""## Step 4: Observe the Anomaly

**Key technique:** the RCF score spikes for a **single ~30s cycle** at the moment of the drop, then the
model adapts and the score returns to 0. An **instant** query usually shows 0 (you miss the spike), so we
use a **range query** to capture the peak score over the last 15 minutes.""")

code('''# Current registration (instant)
results = query_amp('fivegs_amffunction_rm_registeredsubnbr')
print('\u2550\u2550\u2550 AFTER FAULT: Registered Subscribers \u2550\u2550\u2550')
total = 0
for r in sorted(results, key=lambda x: x['metric'].get('pod','')):
    pod = r['metric'].get('pod', 'unknown'); value = int(r['value'][1]); total += value
    status = '\u2717 DOWN' if ('amf1' in pod and value == 0) else '\u2713 OK'
    print(f'  {pod}: {value} UEs  {status}')
print(f'  TOTAL: {total} UEs (was 1000)  |  IMPACT: {1000 - total} users lost service')
print()

# RCF score over a RANGE (captures the single-cycle spike). Instant query would miss it.
print('\u2550\u2550\u2550 RCF Score \u2014 last 15 min (range query, UTC) \u2550\u2550\u2550')
series = query_amp_range('anomaly_detector:score{alias="5g-registered-subscribers"}', minutes=15)
peak = 0.0
if series:
    for ts, val in series[0]['values']:
        v = float(val); peak = max(peak, v)
        if v > 0.1:
            t = datetime.fromtimestamp(float(ts), timezone.utc).strftime('%H:%M:%S')
            print(f'  {t} UTC   score = {v:.3f}   \u2190 ANOMALY DETECTED (> 0.1 threshold)')
print()
print(f'  Peak RCF score in window: {peak:.3f}   ' + ('\u2190 RCF FIRED \u2713' if peak > 0.1
      else '(no spike yet \u2014 re-run in ~30s if the fault was just injected)'))''')

# ---- Step 5: the DevOps Agent investigates (automated) ----
md("""## Step 5: The AWS DevOps Agent Investigates (Automated RCA)

This is the payoff. The moment the RCF score crossed the threshold in Step 4, the `RCF5GRegistrationDrop`
alert fired and the pipeline ran **with no human in the loop**:

`RCF alert → AMP Alertmanager → SNS (open5gs-rcf-rca-trigger) → RCA Lambda (open5gs-rcf-rca) → your DevOps Agent webhook`

The RCA Lambda queried AMP (per-AMF registration + AMF pod restarts), identified the crash-looping AMF, and
POSTed an incident to the webhook you wired in **Step 2** — so the **AWS DevOps Agent has already started an
autonomous investigation**. Open your **Agent Space → Incidents** in the DevOps Agent web app to watch its
timeline and root-cause finding.

The cell below (1) confirms the webhook is still wired, then (2) prints the same signals the agent correlates,
so you can compare its conclusion against ground truth.""")

code('''# Confirm the pipeline is armed (the webhook the RCA Lambda POSTs to when RCF fires)
import boto3, json as _json
try:
    _raw = boto3.client("secretsmanager", region_name=REGION).get_secret_value(
        SecretId="open5gs/devops-agent/webhook")["SecretString"]
    _cfg = _json.loads(_raw)
    if _cfg.get("url") and "PASTE_" not in _cfg.get("url", ""):
        print("Webhook wired (auth=" + str(_cfg.get("auth", "?")) + ") - RCF alerts POST to the DevOps Agent.")
        print("  Open the DevOps Agent Space -> Incidents to watch the live investigation.")
    else:
        print("Webhook NOT set - re-run the Step 2 wiring cell (until then the RCA Lambda only logs to CloudWatch).")
except Exception as e:
    print("Could not read webhook secret: " + str(e)[:120])''')

code('''print('\u2550\u2550\u2550 SIGNALS THE AGENT CORRELATES \u2550\u2550\u2550\\n')
print('1. Per-AMF breakdown (blast radius):')
for r in sorted(query_amp('fivegs_amffunction_rm_registeredsubnbr'), key=lambda x: x['metric'].get('pod','')):
    pod = r['metric'].get('pod', ''); v = int(r['value'][1])
    print(f'   {pod}: {v} registered', '\u2190 AFFECTED (TAC=1)' if v == 0 else '\u2190 healthy')
print()
print('2. AMF1 restart count \u2014 last 12 min (range):')
series = query_amp_range('max(kube_pod_container_status_restarts_total{namespace="open5gs", pod=~"amf1.*"})', minutes=12, step='60s')
if series:
    pts = series[0]['values']
    first = int(float(pts[0][1])); last = int(float(pts[-1][1]))
    print(f'   restarts: {first} \u2192 {last}', '\u2190 CRASH LOOP!' if last > first else '')
    # show the moment restarts began
    prev = None
    for ts, val in pts:
        v = int(float(val))
        if prev is not None and v > prev:
            t = datetime.fromtimestamp(float(ts), timezone.utc).strftime('%H:%M:%S')
            print(f'     {t} UTC: restarts climbed to {v}')
        prev = v
print()
print('3. AMF1 last-terminated reason:')
ok, out, _ = run_kubectl(['get', 'pod', '-n', 'open5gs', '-l', 'app=amf1', '-o',
    'jsonpath={.items[0].status.containerStatuses[0].lastState.terminated.reason}: exit {.items[0].status.containerStatuses[0].lastState.terminated.exitCode}'], timeout=15)
print(f'   {out.strip() or "(pod healthy / no recent termination)"}')
print()
print('\u2550\u2550\u2550 GROUND TRUTH (compare with the agent finding) \u2550\u2550\u2550')
print('Root cause : AMF1 in CrashLoopBackOff after a config change (missing time.t3512, exit 255).')
print('Impact     : ~500 users on TAC=1 lost registration. AMF2 (TAC=2) healthy \u2014 blast radius isolated.')
print('Remediation: Roll back the amf1-config ConfigMap (Step 5).')''')

# ---- Step 6: recovery ----
md("""## Step 6: Recovery

Restore the valid config (with `time.t3512`), let AMF1 become healthy, then restart the TAC=1 gNBs so
their ~500 UEs re-register. Registration ramps back to 1000.""")

code('''# Valid AMF1 config (working dev:eth0 + direct NRF + time.t3512 present)
valid_config = """sbi:
  server:
    no_tls: true
  client:
    no_tls: true
time:
  t3512:
    value: 540
amf:
  sbi:
    - dev: eth0
      port: 7777
  ngap:
    - addr: 0.0.0.0
  metrics:
    - addr: 0.0.0.0
      port: 9090
  guami:
    - plmn_id: {mcc: 999, mnc: 70}
      amf_id: {region: 2, set: 1}
  tai:
    - plmn_id: {mcc: 999, mnc: 70}
      tac: 1
  plmn_support:
    - plmn_id: {mcc: 999, mnc: 70}
      s_nssai:
        - sst: 1
  security:
    integrity_order: [NIA2, NIA1, NIA0]
    ciphering_order: [NEA0, NEA1, NEA2]
  network_name:
    full: Open5GS
  amf_name: open5gs-amf1
nrf:
  sbi:
    - addr: nrf.open5gs.svc.cluster.local
      port: 7777
"""

print('\u2550\u2550\u2550 RECOVERY \u2550\u2550\u2550')
print('Restoring valid config to AMF1...')
ok, cm_yaml, _ = run_kubectl(['create', 'configmap', 'amf1-config', '-n', 'open5gs',
     f'--from-literal=amf.yaml={valid_config}', '--dry-run=client', '-o', 'yaml'], timeout=15)
if ok:
    run_kubectl(['apply', '-f', '-'], stdin=cm_yaml, timeout=30)
    run_kubectl(['delete', 'pod', '-n', 'open5gs', '-l', 'app=amf1', '--wait=false'], timeout=30)
    run_kubectl(['rollout', 'status', 'deploy/amf1', '-n', 'open5gs'], timeout=90)
    # restart TAC=1 gNBs so their ~500 UEs re-register
    run_kubectl(['rollout', 'restart', 'statefulset/gnb1a', 'statefulset/gnb1b', '-n', 'open5gs'], timeout=30)
    print('\u2713 Valid config restored + gNBs restarting. Waiting 150s for UEs to re-register...')
    for _ in range(10):
        time.sleep(15)
        try:
            total = sum(int(float(r['value'][1])) for r in query_amp('fivegs_amffunction_rm_registeredsubnbr'))
            print(f'  registered subscribers: {total}  (climbing back to 1000...)')
            if total >= 1000:
                print('  fully recovered'); break
        except Exception as e:
            print(f'  (AMP query retry: {str(e)[:80]})')
    total = int(query_amp('sum(fivegs_amffunction_rm_registeredsubnbr)')[0]['value'][1])
    print(f'\\n\u2550\u2550\u2550 POST-RECOVERY \u2550\u2550\u2550')
    print(f'  Registered subscribers: {total} / 1000')
    print('  ' + ('\u2713 RECOVERED' if total >= 950 else f'\u23f3 Still re-registering ({total}/1000) \u2014 re-run this check in 60s'))''')

# ---- Summary ----
md("""---
## Summary

| Phase | registeredsubnbr | RCF Score | Root Cause |
|---|---|---|---|
| Healthy | 1000 | 0 | \u2014 |
| Fault injected | ~500 | **1.0** (peak, > 0.1) | AMF1 CrashLoopBackOff (missing `time.t3512`) |
| Recovered | 1000 | 0 | Config rolled back |

### Key Takeaways
1. **RCF detects onset instantly** \u2014 a 50% subscriber drop spikes the score to ~1.0 within one 30s cycle.
2. **Capture the spike with a range query** \u2014 the score returns to 0 as the model adapts, so an instant query misses it. Always query the score over a time range (in **UTC**).
3. **The DevOps Agent pinpoints root cause automatically** \u2014 AMF1 restart count climbs at the same timestamp as the drop; the per-AMF breakdown shows the blast radius (TAC=1 only).
4. **Data-plane throughput** uses `container_network_*_bytes_total` (the open5gs `fivegs_ep_n3_gtp_*` counters are not wired in 2.6.6).
5. **Fast, isolated recovery** \u2014 fix config, restart, UEs auto-re-register; AMF2 never affected.""")

notebook = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "conda_python3", "language": "python", "name": "conda_python3"},
        "language_info": {"name": "python", "version": "3.10.0"},
    },
    "nbformat": 4,
    "nbformat_minor": 4,
}

out_path = sys.argv[1]
with open(out_path, 'w') as f:
    json.dump(notebook, f, indent=1, ensure_ascii=False)
print(f'Wrote {out_path} with {len(cells)} cells')
