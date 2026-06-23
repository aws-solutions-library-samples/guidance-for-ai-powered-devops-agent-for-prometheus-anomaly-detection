#!/usr/bin/env bash
# Provision multiple test subscribers (IMSI 999700000000001 - 999700000000010) into open5gs MongoDB.
# Idempotent. Run after the core is up; persists thanks to the mongodb PVC.
set -euo pipefail

NUM_UES=${1:-10}
echo "Provisioning $NUM_UES subscribers..."

for i in $(seq 1 $NUM_UES); do
  IMSI=$(printf "999700000000%03d" $i)
  kubectl exec -n open5gs deploy/mongodb -- mongosh open5gs --quiet --eval "
db.subscribers.replaceOne({imsi:\"$IMSI\"},
 {imsi:\"$IMSI\",
  security:{k:\"465B5CE8B199B49FAA5F0A2EE238A6BC\",opc:\"E8ED289DEBA952E4283B54E88E6183CA\",amf:\"8000\",sqn:NumberLong(\"0\")},
  ambr:{downlink:{value:1,unit:3},uplink:{value:1,unit:3}},
  slice:[{sst:1,default_indicator:true,session:[{name:\"internet\",type:3,ambr:{downlink:{value:1,unit:3},uplink:{value:1,unit:3}},qos:{index:9,arp:{priority_level:8,pre_emption_capability:1,pre_emption_vulnerability:1}}}]}],
  schema_version:1,__v:0},{upsert:true});"
  echo "  ✓ IMSI $IMSI"
done

kubectl exec -n open5gs deploy/mongodb -- mongosh open5gs --quiet --eval \
  "print('Total subscribers: '+db.subscribers.countDocuments({}));"
