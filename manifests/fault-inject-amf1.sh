#!/usr/bin/env bash
# Fault Injection: Bad config push to AMF1
# Simulates a human error pushing invalid configuration to AMF1.
# Impact: AMF1 enters CrashLoopBackOff → 39 UEs lose registration.
# AMF2 (41 UEs) remains completely unaffected.
set -euo pipefail

ACTION=${1:-help}
NAMESPACE="open5gs"

case "$ACTION" in
  break)
    echo "═══════════════════════════════════════════════════════════"
    echo "  FAULT INJECTION: Pushing bad config to AMF1"
    echo "  Expected impact: ~39 users deregister (AMF1 serves TAC=1)"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "Before: $(kubectl get deploy/amf1 -n $NAMESPACE -o jsonpath='{.status.readyReplicas}') AMF1 replicas ready"

    # Push invalid config — missing required 'time.t3512' field
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
    - addr: 0.0.0.0
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
scp:
  sbi:
    - addr: scp.open5gs.svc.cluster.local
      port: 7777
' --dry-run=client -o yaml | kubectl apply -f -

    # Delete AMF1 pods so they restart with the broken config.
    # IMPORTANT: use delete (not 'rollout restart') — rollout restart creates a
    # surge pod while the OLD healthy pod keeps serving, so subscribers never drop.
    # Deleting forces the ReplicaSet to recreate with the broken config → crash loop.
    kubectl delete pod -n $NAMESPACE -l app=amf1 --wait=false
    echo ""
    echo "✗ Bad config pushed. AMF1 will enter CrashLoopBackOff."
    echo "  Watch: kubectl get pods -n $NAMESPACE -l app=amf1 -w"
    echo "  RCF should fire within 30-60s as registeredsubnbr drops 100→50."
    ;;

  fix)
    echo "═══════════════════════════════════════════════════════════"
    echo "  RECOVERY: Restoring valid config to AMF1"
    echo "═══════════════════════════════════════════════════════════"

    # Restore correct config with time.t3512
    kubectl create configmap amf1-config -n $NAMESPACE \
      --from-literal=amf.yaml='
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
    - addr: 0.0.0.0
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
scp:
  sbi:
    - addr: scp.open5gs.svc.cluster.local
      port: 7777
' --dry-run=client -o yaml | kubectl apply -f -

    # Delete crashing AMF1 pods so they restart with the valid config
    kubectl delete pod -n $NAMESPACE -l app=amf1 --wait=false
    echo "  Waiting for AMF1 to become healthy..."
    kubectl rollout status deploy/amf1 -n $NAMESPACE --timeout=90s 2>&1 || true

    # Restart the gNBs that connect to AMF1 (TAC=1) so their UEs re-register.
    # Without this, the 50 UEs stay deregistered until their next attach attempt.
    echo "  Restarting gnb1a/gnb1b to force UE re-registration..."
    kubectl rollout restart statefulset/gnb1a statefulset/gnb1b -n $NAMESPACE
    echo ""
    echo "✓ Valid config restored. AMF1 healthy; UEs re-registering (60-90s to reach 100)."
    ;;

  status)
    echo "═══ Current State ═══"
    echo "AMF1 pods:"
    kubectl get pods -n $NAMESPACE -l app=amf1
    echo ""
    echo "AMF1 restarts:"
    kubectl get pods -n $NAMESPACE -l app=amf1 -o jsonpath='{range .items[*]}{.metadata.name}: restarts={.status.containerStatuses[0].restartCount}{"\n"}{end}'
    echo ""
    echo "Registered subscribers (from Prometheus MCP — query AMP separately):"
    echo "  sum(fivegs_amffunction_rm_registeredsubnbr)"
    ;;

  help|*)
    echo "Usage: $0 {break|fix|status}"
    echo ""
    echo "  break  - Push bad config to AMF1 (triggers RCF anomaly)"
    echo "  fix    - Restore valid config (recovery)"
    echo "  status - Show current AMF1 state"
    ;;
esac
