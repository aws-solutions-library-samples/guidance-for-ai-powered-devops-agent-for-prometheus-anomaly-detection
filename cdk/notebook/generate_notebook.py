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

**Scenario**: A bad config push to AMF1 crashes it (CrashLoopBackOff), so **~500 of 1000 UEs** lose registration. RCF flags the drop within one 30s evaluation cycle. We then correlate with infrastructure metrics to pinpoint root cause, and recover.

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

# ---- Step 2: fault ----
md("""## Step 2: Inject Fault (Bad Config Push to AMF1)

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
        time.sleep(75)
    else:
        print('\u2717 Could not apply config \u2014 check kubectl connectivity (Setup cell).')
else:
    print('\u2717 Could not generate config \u2014 check kubectl is installed (Setup cell).')''')

# ---- Step 3: observe ----
md("""## Step 3: Observe the Anomaly

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

# ---- Step 4: root cause ----
md("""## Step 4: Root Cause Analysis

Correlate the registration drop with infrastructure signals. All signals should align in time:
the registration drop, the RCF score spike, and the AMF1 restart count climbing.""")

code('''print('\u2550\u2550\u2550 ROOT CAUSE ANALYSIS \u2550\u2550\u2550\\n')
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
print('\u2550\u2550\u2550 CONCLUSION \u2550\u2550\u2550')
print('Root cause : AMF1 in CrashLoopBackOff after a config change (missing time.t3512, exit 255).')
print('Impact     : ~500 users on TAC=1 lost registration. AMF2 (TAC=2) healthy \u2014 blast radius isolated.')
print('Remediation: Roll back the amf1-config ConfigMap (Step 5).')''')

# ---- Step 5: recovery ----
md("""## Step 5: Recovery

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
    time.sleep(150)
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
3. **Infra correlation pinpoints root cause** \u2014 AMF1 restart count climbs at the same timestamp as the drop; the per-AMF breakdown shows the blast radius (TAC=1 only).
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
