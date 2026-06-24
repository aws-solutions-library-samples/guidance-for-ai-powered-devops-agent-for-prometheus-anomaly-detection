#!/usr/bin/env bash
# Fault Injection: Bad config push to AMF1
# Simulates a human error pushing invalid configuration to AMF1.
# Impact: AMF1 enters CrashLoopBackOff → ~500 UEs lose registration (AMF1 serves TAC=1).
# AMF2 (~500 UEs, TAC=2) remains completely unaffected.
# Configs match the working multi-NF deployment (dev:eth0 advertise + direct NRF).
set -euo pipefail

ACTION=${1:-help}
NAMESPACE="open5gs"

# Valid AMF1 config (dev:eth0 so it registers its pod IP; direct NRF; t3512 present).
read -r -d '' GOOD_CFG <<'EOF' || true
sbi:
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
EOF

case "$ACTION" in
  break)
    echo "═══════════════════════════════════════════════════════════"
    echo "  FAULT INJECTION: Pushing bad config to AMF1"
    echo "  Expected impact: ~500 users deregister (AMF1 serves TAC=1)"
    echo "  Total registration drops 1000 → ~500; RCF score spikes >0.1"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "Before: $(kubectl get deploy/amf1 -n $NAMESPACE -o jsonpath='{.status.readyReplicas}') AMF1 replica(s) ready"

    # Push invalid config — the required 'time.t3512' field is REMOVED.
    # open5gs amfd fails to start without it → CrashLoopBackOff.
    kubectl create configmap amf1-config -n $NAMESPACE \
      --from-literal=amf.yaml='
# BROKEN CONFIG - pushed by CI/CD pipeline at '"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'
# ERROR: missing time.t3512 (required by open5gs AMF)
sbi:
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
' --dry-run=client -o yaml | kubectl apply -f -

    # Delete AMF1 pods so they restart with the broken config.
    # Use delete (not 'rollout restart') — rollout restart keeps the OLD healthy
    # pod serving during surge, so subscribers never drop. Delete forces the
    # ReplicaSet to recreate immediately with the broken config → crash loop.
    kubectl delete pod -n $NAMESPACE -l app=amf1 --wait=false
    echo ""
    echo "✗ Bad config pushed. AMF1 will enter CrashLoopBackOff."
    echo "  Watch:  kubectl get pods -n $NAMESPACE -l app=amf1 -w"
    echo "  RCF should fire within 30-60s as registeredsubnbr drops 1000 → ~500."
    ;;

  fix)
    echo "═══════════════════════════════════════════════════════════"
    echo "  RECOVERY: Restoring valid config to AMF1"
    echo "═══════════════════════════════════════════════════════════"

    kubectl create configmap amf1-config -n $NAMESPACE \
      --from-literal=amf.yaml="$GOOD_CFG" --dry-run=client -o yaml | kubectl apply -f -

    # Delete crashing AMF1 pods so they restart with the valid config
    kubectl delete pod -n $NAMESPACE -l app=amf1 --wait=false
    echo "  Waiting for AMF1 to become healthy..."
    kubectl rollout status deploy/amf1 -n $NAMESPACE --timeout=90s 2>&1 || true

    # Restart the gNBs that connect to AMF1 (TAC=1) so their ~500 UEs re-register.
    echo "  Restarting gnb1a/gnb1b to force UE re-registration..."
    kubectl rollout restart statefulset/gnb1a statefulset/gnb1b -n $NAMESPACE
    echo ""
    echo "✓ Valid config restored. AMF1 healthy; UEs re-registering (2-3 min to reach 1000)."
    ;;

  status)
    echo "═══ Current State ═══"
    echo "AMF1 pods:"
    kubectl get pods -n $NAMESPACE -l app=amf1
    echo ""
    echo "AMF1 restarts:"
    kubectl get pods -n $NAMESPACE -l app=amf1 -o jsonpath='{range .items[*]}{.metadata.name}: restarts={.status.containerStatuses[0].restartCount}{"\n"}{end}'
    echo ""
    echo "Registered subscribers (query AMP via Prometheus MCP):"
    echo "  sum(fivegs_amffunction_rm_registeredsubnbr)   # expect 1000 healthy, ~500 during fault"
    echo "  anomaly_detector:score{alias=\"5g-registered-subscribers\"}   # >0.1 = anomaly"
    ;;

  help|*)
    echo "Usage: $0 {break|fix|status}"
    echo ""
    echo "  break  - Push bad config to AMF1 (triggers RCF anomaly, ~500 UEs drop)"
    echo "  fix    - Restore valid config (recovery to 1000)"
    echo "  status - Show current AMF1 state"
    ;;
esac
