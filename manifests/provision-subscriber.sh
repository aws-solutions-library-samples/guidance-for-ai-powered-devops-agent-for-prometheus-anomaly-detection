#!/usr/bin/env bash
# Provision the default test subscriber (IMSI 999700000000001) into open5gs MongoDB.
# Idempotent. Run after the core is up; persists thanks to the mongodb PVC.
set -euo pipefail
kubectl exec -n open5gs deploy/mongodb -- mongosh open5gs --quiet --eval '
db.subscribers.replaceOne({imsi:"999700000000001"},
 {imsi:"999700000000001",
  security:{k:"465B5CE8B199B49FAA5F0A2EE238A6BC",opc:"E8ED289DEBA952E4283B54E88E6183CA",amf:"8000",sqn:NumberLong("0")},
  ambr:{downlink:{value:1,unit:3},uplink:{value:1,unit:3}},
  slice:[{sst:1,default_indicator:true,session:[{name:"internet",type:3,ambr:{downlink:{value:1,unit:3},uplink:{value:1,unit:3}},qos:{index:9,arp:{priority_level:8,pre_emption_capability:1,pre_emption_vulnerability:1}}}]}],
  schema_version:1,__v:0},{upsert:true});
print("subscribers: "+db.subscribers.countDocuments({}));'
