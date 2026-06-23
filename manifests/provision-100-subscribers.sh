#!/usr/bin/env bash
# Provision 100 subscribers across 4 DNNs into open5gs MongoDB.
# IMSI 001-025 → DNN internet  (UPF1, 10.45.0.0/16)
# IMSI 026-050 → DNN internet2 (UPF2, 10.46.0.0/16)
# IMSI 051-075 → DNN iot       (UPF3, 10.47.0.0/16)
# IMSI 076-100 → DNN edge      (UPF4, 10.48.0.0/16)
# Idempotent. Persists via mongodb PVC.
set -euo pipefail

get_dnn() {
  local i=$1
  if [ $i -le 25 ]; then echo "internet"
  elif [ $i -le 50 ]; then echo "internet2"
  elif [ $i -le 75 ]; then echo "iot"
  else echo "edge"; fi
}

echo "Provisioning 100 subscribers (4 DNNs × 25 UEs)..."
for i in $(seq 1 100); do
  IMSI=$(printf "999700000000%03d" $i)
  DNN=$(get_dnn $i)
  kubectl exec -n open5gs deploy/mongodb -- mongosh open5gs --quiet --eval "
db.subscribers.replaceOne({imsi:\"$IMSI\"},
{imsi:\"$IMSI\",
 security:{k:\"465B5CE8B199B49FAA5F0A2EE238A6BC\",opc:\"E8ED289DEBA952E4283B54E88E6183CA\",amf:\"8000\",sqn:NumberLong(\"0\")},
 ambr:{downlink:{value:1,unit:3},uplink:{value:1,unit:3}},
 slice:[{sst:1,default_indicator:true,
   session:[{name:\"$DNN\",type:3,
     ambr:{downlink:{value:1,unit:3},uplink:{value:1,unit:3}},
     qos:{index:9,arp:{priority_level:8,pre_emption_capability:1,pre_emption_vulnerability:1}}}]}],
 schema_version:1,__v:0},{upsert:true});" 2>/dev/null
  printf "\r  ✓ %03d/100 IMSI %s DNN=%s" $i "$IMSI" "$DNN"
done
echo ""
kubectl exec -n open5gs deploy/mongodb -- mongosh open5gs --quiet --eval \
  "print('Total subscribers: '+db.subscribers.countDocuments({}));"
echo "Done."
