#!/usr/bin/env python3
"""Generate manifests/grafana-incluster.yaml: standalone Grafana (ClusterIP) that
queries Amazon Managed Prometheus via SigV4 (IRSA), with a pre-built 5G demo dashboard.
Security: ClusterIP only (no public LB) -> access via kubectl port-forward."""
import json, sys

WS = "ws-185ff7f8-c698-4d0e-9135-945b03aeccd1"
REGION = "us-east-1"
ROLE_ARN = "arn:aws:iam::985090322243:role/open5gs-grafana-amp-query"
AMP_URL = f"https://aps-workspaces.{REGION}.amazonaws.com/workspaces/{WS}"

def ts_panel(title, exprs, gridPos, pid, unit="short", legend=None, thresholds=None, stack=False):
    targets = [{"expr": e, "legendFormat": (legend[i] if legend else ""), "refId": chr(65+i)}
               for i, e in enumerate(exprs)]
    fc = {"defaults": {"unit": unit, "custom": {"drawStyle": "line", "fillOpacity": 10 if not stack else 30,
          "stacking": {"mode": "normal" if stack else "none"}}}, "overrides": []}
    if thresholds:
        fc["defaults"]["thresholds"] = {"mode": "absolute", "steps": thresholds}
        fc["defaults"]["custom"]["thresholdsStyle"] = {"mode": "line"}
    return {"type": "timeseries", "title": title, "gridPos": gridPos, "id": pid,
            "datasource": {"type": "prometheus", "uid": "amp"},
            "targets": targets, "fieldConfig": fc,
            "options": {"legend": {"displayMode": "table", "placement": "bottom", "calcs": ["lastNotNull", "max"]},
                        "tooltip": {"mode": "multi"}}}

def stat_panel(title, expr, gridPos, pid, unit="short", thresholds=None):
    fc = {"defaults": {"unit": unit}, "overrides": []}
    if thresholds:
        fc["defaults"]["thresholds"] = {"mode": "absolute", "steps": thresholds}
        fc["defaults"]["color"] = {"mode": "thresholds"}
    return {"type": "stat", "title": title, "gridPos": gridPos, "id": pid,
            "datasource": {"type": "prometheus", "uid": "amp"},
            "targets": [{"expr": expr, "refId": "A"}], "fieldConfig": fc,
            "options": {"colorMode": "background", "graphMode": "area", "reduceOptions": {"calcs": ["lastNotNull"]}}}

panels = [
    stat_panel("Registered Subscribers (total)", "sum(fivegs_amffunction_rm_registeredsubnbr)",
               {"h": 4, "w": 6, "x": 0, "y": 0}, 1,
               thresholds=[{"color": "red", "value": None}, {"color": "yellow", "value": 800}, {"color": "green", "value": 950}]),
    stat_panel("PDU Sessions (total)", "sum(fivegs_smffunction_sm_sessionnbr)",
               {"h": 4, "w": 6, "x": 6, "y": 0}, 2,
               thresholds=[{"color": "red", "value": None}, {"color": "yellow", "value": 800}, {"color": "green", "value": 950}]),
    stat_panel("Active UEs (SMF)", "sum(ues_active)", {"h": 4, "w": 6, "x": 12, "y": 0}, 3),
    stat_panel("RCF Anomaly Score", 'max(anomaly_detector:score{alias="5g-registered-subscribers"})',
               {"h": 4, "w": 6, "x": 18, "y": 0}, 4,
               thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 0.1}]),

    ts_panel("Registration over time (total + per AMF)",
             ["sum(fivegs_amffunction_rm_registeredsubnbr)", "fivegs_amffunction_rm_registeredsubnbr"],
             {"h": 8, "w": 12, "x": 0, "y": 4}, 5, unit="short",
             legend=["total", "{{pod}}"]),
    ts_panel("RCF: value vs learned band  (score on right axis)",
             ['anomaly_detector:value{alias="5g-registered-subscribers"}',
              'anomaly_detector:upper_band{alias="5g-registered-subscribers"}',
              'anomaly_detector:lower_band{alias="5g-registered-subscribers"}',
              'anomaly_detector:score{alias="5g-registered-subscribers"}'],
             {"h": 8, "w": 12, "x": 12, "y": 4}, 6, unit="short",
             legend=["value", "upper_band", "lower_band", "score"]),

    ts_panel("PDU sessions per UPF", ["fivegs_upffunction_upf_sessionnbr"],
             {"h": 8, "w": 12, "x": 0, "y": 12}, 7, unit="short", legend=["{{pod}}"]),
    ts_panel("User-plane throughput per UPF (RX+TX)",
             ['sum by (pod) (rate(container_network_receive_bytes_total{namespace="open5gs", pod=~"upf.*"}[2m]) '
              '+ rate(container_network_transmit_bytes_total{namespace="open5gs", pod=~"upf.*"}[2m]))'],
             {"h": 8, "w": 12, "x": 12, "y": 12}, 8, unit="Bps", legend=["{{pod}}"]),

    ts_panel("AMF pod restarts (fault signal)",
             ['max by (pod) (kube_pod_container_status_restarts_total{namespace="open5gs", pod=~"amf.*"})'],
             {"h": 7, "w": 24, "x": 0, "y": 20}, 9, unit="short", legend=["{{pod}}"]),
]

dashboard = {
    "uid": "open5gs-5g-rcf", "title": "open5gs 5G — RCF Anomaly Detection (1000 UEs)",
    "tags": ["5g", "open5gs", "rcf", "amp"], "timezone": "browser", "schemaVersion": 39,
    "refresh": "30s", "time": {"from": "now-1h", "to": "now"}, "panels": panels,
}

dash_json = json.dumps(dashboard, indent=2)
dash_indented = "\n".join("    " + l for l in dash_json.splitlines())

datasources_yaml = f"""apiVersion: 1
datasources:
  - name: AMP
    uid: amp
    type: prometheus
    access: proxy
    url: {AMP_URL}
    isDefault: true
    jsonData:
      httpMethod: POST
      sigV4Auth: true
      sigV4AuthType: default
      sigV4Region: {REGION}
      timeInterval: 30s
"""

provider_yaml = """apiVersion: 1
providers:
  - name: '5g-dashboards'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    editable: true
    options:
      path: /var/lib/grafana/dashboards
"""

def indent(text, n):
    return "\n".join(" " * n + l for l in text.splitlines())

manifest = f"""---
# In-cluster Grafana for the open5gs 5G RCF demo.
# SECURITY: ClusterIP only (NO public LoadBalancer on :3000, per aws-security-guardrails).
# Access:  kubectl -n monitoring port-forward svc/grafana 3000:3000  ->  http://localhost:3000
# Queries Amazon Managed Prometheus via SigV4 using IRSA (SA: monitoring/grafana-amp).
apiVersion: v1
kind: ServiceAccount
metadata:
  name: grafana-amp
  namespace: monitoring
  annotations:
    eks.amazonaws.com/role-arn: {ROLE_ARN}
---
apiVersion: v1
kind: Secret
metadata:
  name: grafana-admin
  namespace: monitoring
type: Opaque
stringData:
  admin-user: admin
  admin-password: open5gs-demo-2026
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasources.yaml: |
{indent(datasources_yaml, 4)}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-provider
  namespace: monitoring
data:
  provider.yaml: |
{indent(provider_yaml, 4)}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-5g
  namespace: monitoring
data:
  5g-demo.json: |
{dash_indented}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: monitoring
  labels: {{app: grafana}}
spec:
  replicas: 1
  selector: {{matchLabels: {{app: grafana}}}}
  template:
    metadata:
      labels: {{app: grafana}}
    spec:
      serviceAccountName: grafana-amp
      securityContext: {{fsGroup: 472, runAsUser: 472}}
      containers:
        - name: grafana
          image: grafana/grafana:11.1.0
          ports:
            - {{containerPort: 3000, name: http}}
          env:
            - {{name: GF_SECURITY_ADMIN_USER, valueFrom: {{secretKeyRef: {{name: grafana-admin, key: admin-user}}}}}}
            - {{name: GF_SECURITY_ADMIN_PASSWORD, valueFrom: {{secretKeyRef: {{name: grafana-admin, key: admin-password}}}}}}
            - {{name: GF_AUTH_SIGV4_AUTH_ENABLED, value: "true"}}
            - {{name: AWS_REGION, value: {REGION}}}
            - {{name: AWS_STS_REGIONAL_ENDPOINTS, value: regional}}
            - {{name: GF_INSTALL_PLUGINS, value: ""}}
            - {{name: GF_USERS_DEFAULT_THEME, value: dark}}
          resources:
            requests: {{cpu: 100m, memory: 128Mi}}
            limits: {{memory: 512Mi}}
          volumeMounts:
            - {{name: datasources, mountPath: /etc/grafana/provisioning/datasources}}
            - {{name: dashboard-provider, mountPath: /etc/grafana/provisioning/dashboards}}
            - {{name: dashboards, mountPath: /var/lib/grafana/dashboards}}
          readinessProbe:
            httpGet: {{path: /api/health, port: 3000}}
            initialDelaySeconds: 20
            periodSeconds: 10
      volumes:
        - {{name: datasources, configMap: {{name: grafana-datasources}}}}
        - {{name: dashboard-provider, configMap: {{name: grafana-dashboard-provider}}}}
        - {{name: dashboards, configMap: {{name: grafana-dashboard-5g}}}}
---
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: monitoring
  labels: {{app: grafana}}
spec:
  type: ClusterIP
  selector: {{app: grafana}}
  ports:
    - {{port: 3000, targetPort: 3000, name: http}}
"""

out = sys.argv[1]
with open(out, "w") as f:
    f.write(manifest)
# validate the embedded dashboard JSON round-trips
json.loads(dash_json)
print(f"Wrote {out} ({len(manifest.splitlines())} lines); dashboard has {len(panels)} panels; JSON valid")
