#!/usr/bin/env bash
# Patch UPF deployments with a postStart hook that brings up ogstun + NAT.
# Needed because running open5gs-upfd with a custom config bypasses the image
# entrypoint that normally configures the ogstun TUN device.
set -euo pipefail
for n in 1 2 3 4; do
  case $n in
    1) GW=10.45.0.1; SUB=10.45.0.0/16;;
    2) GW=10.46.0.1; SUB=10.46.0.0/16;;
    3) GW=10.47.0.1; SUB=10.47.0.0/16;;
    4) GW=10.48.0.1; SUB=10.48.0.0/16;;
  esac
  kubectl patch deploy upf$n -n open5gs --type=json -p "[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/lifecycle\",\"value\":{\"postStart\":{\"exec\":{\"command\":[\"/bin/sh\",\"-c\",\"for i in \$(seq 1 60); do ip link show ogstun >/dev/null 2>&1 && break; sleep 1; done; ip addr add $GW/16 dev ogstun 2>/dev/null || true; ip link set ogstun up; sysctl -w net.ipv4.ip_forward=1; iptables -t nat -C POSTROUTING -s $SUB ! -o ogstun -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s $SUB ! -o ogstun -j MASQUERADE\"]}}}}]"
done
echo "UPF ogstun postStart hooks applied."
