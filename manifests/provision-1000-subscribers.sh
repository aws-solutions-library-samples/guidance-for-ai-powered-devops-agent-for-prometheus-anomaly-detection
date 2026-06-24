#!/usr/bin/env bash
# Provision 1000 subscribers across 4 DNNs into open5gs MongoDB (single bulkWrite — fast).
# IMSI 0001-0250 → DNN internet  (UPF1, 10.45.0.0/16)
# IMSI 0251-0500 → DNN internet2 (UPF2, 10.46.0.0/16)
# IMSI 0501-0750 → DNN iot       (UPF3, 10.47.0.0/16)
# IMSI 0751-1000 → DNN edge      (UPF4, 10.48.0.0/16)
# IMSI format: 99970000000%04d  (matches ueransim-multi.yaml). Idempotent via PVC.
set -euo pipefail

echo "Provisioning 1000 subscribers (4 DNNs × 250 UEs) via bulkWrite..."
kubectl exec -n open5gs deploy/mongodb -- mongosh open5gs --quiet --eval '
var ops = [];
for (var i = 1; i <= 1000; i++) {
  var imsi = "99970000000" + ("0000" + i).slice(-4);
  var dnn = i <= 250 ? "internet" : i <= 500 ? "internet2" : i <= 750 ? "iot" : "edge";
  ops.push({ replaceOne: {
    filter: { imsi: imsi },
    replacement: {
      imsi: imsi,
      security: { k: "465B5CE8B199B49FAA5F0A2EE238A6BC", opc: "E8ED289DEBA952E4283B54E88E6183CA", amf: "8000", sqn: NumberLong("0") },
      ambr: { downlink: { value: 1, unit: 3 }, uplink: { value: 1, unit: 3 } },
      slice: [ { sst: 1, default_indicator: true,
        session: [ { name: dnn, type: 3,
          ambr: { downlink: { value: 1, unit: 3 }, uplink: { value: 1, unit: 3 } },
          qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } } } ] } ],
      schema_version: 1, __v: 0
    },
    upsert: true
  }});
}
var res = db.subscribers.bulkWrite(ops);
print("upserts=" + res.upsertedCount + " modified=" + res.modifiedCount);
print("Total subscribers: " + db.subscribers.countDocuments({}));
'
echo "Done."
