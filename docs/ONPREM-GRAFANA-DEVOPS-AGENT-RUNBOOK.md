# Runbook — Connect an On-Prem Grafana to AWS DevOps Agent

**Use case:** Grafana runs **on-premises** (or in any private/non-AWS network). You want the
**AWS DevOps Agent** (an AWS-managed service) to query it during investigations. The agent must
reach Grafana over **public HTTPS** with a service-account token. Because the on-prem network
typically can't open inbound ports, a small **relay VM with outbound internet** runs a
**Cloudflare Tunnel** (`cloudflared`) that exposes Grafana on a public HTTPS hostname using
**outbound-only** connections — no inbound firewall changes.

> The AWS DevOps Agent built-in Grafana connector is **read-only** (query/read dashboards, metrics,
> alerts). Write tools are disabled and cannot be enabled.

---

## Architecture

```
 On-prem / private network                         Internet                         AWS
 ┌──────────────────────────────┐                                        ┌───────────────────────┐
 │  Grafana (on-prem)            │                                        │  AWS DevOps Agent      │
 │  http://grafana.lan:3000      │                                        │  (managed service)     │
 │            ▲                  │                                        └───────────┬───────────┘
 │            │ LAN (HTTP)       │                                                    │ HTTPS + glsa_ token
 │  Relay VM (outbound internet) │     outbound 443/QUIC (no inbound)                 ▼
 │  cloudflared  ────────────────┼──────────────────────────▶  Cloudflare edge  ◀────┘
 └──────────────────────────────┘                         https://<name>.trycloudflare.com  (quick)
                                                           https://grafana.example.com       (named)
```

- `cloudflared` on the relay VM dials **out** to Cloudflare (443/QUIC). The DevOps Agent connects
  to the Cloudflare hostname; Cloudflare forwards to the relay VM, which proxies to on-prem Grafana.
- **No inbound ports** are opened on the on-prem firewall.

---

## Prerequisites

- **Grafana 9.0+** reachable from the relay VM over the LAN (e.g. `http://grafana.lan:3000`).
- **Relay VM** (Linux, e.g. Ubuntu/RHEL/Amazon Linux) with **outbound** internet to Cloudflare
  (TCP 443 + UDP 7844/QUIC). Can be the Grafana host itself or a separate VM on the same network.
- A **Grafana service account + token** with **Viewer** role.
- Access to the **AWS DevOps Agent console** and an **Agent Space**.
- *(Production / stable hostname only)* A **Cloudflare account** and a **domain managed in Cloudflare**.

---

## Decision: which connectivity option

| Option | When to use | Inbound firewall | Stable URL |
|---|---|---|---|
| **A. Cloudflare Tunnel — quick** | Fast test/POC | None (outbound only) | ❌ ephemeral `*.trycloudflare.com` |
| **B. Cloudflare Tunnel — named** | Production | None (outbound only) | ✅ `grafana.example.com` |
| **C. Direct public HTTPS reverse proxy** | You can open inbound 443 + have a cert | Yes (443 inbound) | ✅ your hostname |

This runbook focuses on **A** (test) and **B** (production). Option **C** is in Appendix A.

---

## Part 1 — Create the Grafana service account token

**UI:** Grafana → **Administration → Users and access → Service accounts → Add service account**
→ name `sa-devops-agent`, role **Viewer** → **Add service account token** → copy the `glsa_…` value.

**API (alternative):**
```bash
GRAFANA=http://grafana.lan:3000
ADMIN='admin:<admin-password>'
# Create the service account (Viewer)
SA_ID=$(curl -sS -u "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"sa-devops-agent","role":"Viewer"}' \
  "$GRAFANA/api/serviceaccounts" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# Create a token
curl -sS -u "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"devops-agent-token"}' \
  "$GRAFANA/api/serviceaccounts/$SA_ID/tokens"
# -> copy the "key":"glsa_..." from the response
```

Verify the token can read:
```bash
curl -sS -H "Authorization: Bearer glsa_xxx" "$GRAFANA/api/search?type=dash-db" | head -c 300
```

---

## Part 2 — Install cloudflared on the relay VM

```bash
# Debian/Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# RHEL/CentOS/Amazon Linux
sudo rpm -i https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm

cloudflared --version
```

Confirm the relay VM can reach on-prem Grafana over the LAN:
```bash
curl -sS -o /dev/null -w "grafana HTTP %{http_code}\n" http://grafana.lan:3000/api/health
```

---

## Part 3A — Quick tunnel (test, ephemeral URL)

```bash
cloudflared tunnel --no-autoupdate --url http://grafana.lan:3000
```
Copy the printed `https://<random-words>.trycloudflare.com` URL. Keep the process running.
Run it persistently with a simple systemd unit or `screen`/`tmux` for the duration of the test.

> The quick-tunnel URL changes every time `cloudflared` restarts. For anything beyond a quick test,
> use Part 3B.

---

## Part 3B — Named tunnel (production, stable hostname + systemd)

Requires a Cloudflare account and a domain in Cloudflare (e.g. `example.com`).

```bash
# 1. Authenticate cloudflared to your Cloudflare account (opens a browser/login URL)
cloudflared tunnel login

# 2. Create a named tunnel (stores credentials JSON under ~/.cloudflared/)
cloudflared tunnel create grafana-devops
#   -> note the Tunnel UUID and the credentials file path

# 3. Configuration file
sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml >/dev/null <<'YAML'
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: grafana-devops.example.com
    service: http://grafana.lan:3000      # on-prem Grafana LAN address
  - service: http_status:404
YAML
sudo cp ~/.cloudflared/<TUNNEL_UUID>.json /etc/cloudflared/

# 4. Create the public DNS record (CNAME -> tunnel)
cloudflared tunnel route dns grafana-devops grafana-devops.example.com

# 5. Install + start as a service (auto-restart on boot)
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared --no-pager
```

Your stable Grafana URL is now `https://grafana-devops.example.com`.

---

## Part 4 — Register Grafana in AWS DevOps Agent

Console → **Capability Providers** → under **Telemetry** find **Grafana** → **Register**:

| Field | Value |
|---|---|
| **Service Name** | `onprem-grafana` (alphanumeric, `-`, `_`) |
| **Grafana URL** | the public HTTPS URL (`https://grafana-devops.example.com` or the quick-tunnel URL) |
| **Service Account Access Token** | the `glsa_…` token from Part 1 |
| **Description** | e.g. `On-prem Grafana via Cloudflare Tunnel` |
| Private connection | **unchecked** (the endpoint is public) |

→ **Next → Submit**. The agent validates the connection; Grafana appears under **Currently registered**.

> IaC option: the same registration is available via the `AWS::DevOpsAgent::Service` CloudFormation
> resource / the DevOps Agent `register-service` API (Grafana service type). Use the console first to
> confirm field values, then codify.

---

## Part 5 — Attach to an Agent Space and test

1. Console → select your **Agent Space** → **Capabilities** tab.
2. **Telemetry** section → **Add** → select **Grafana** → **Save**.
3. Test by asking the agent, e.g.:
   - *"List the Grafana dashboards."*
   - *"Query the registered-subscribers metric from Grafana."*

---

## Part 6 (optional) — Auto-trigger investigations on alerts (2-way)

On-prem **self-managed** Grafana supports **webhook contact points** (Amazon Managed Grafana does not),
so alerts can start a DevOps Agent investigation automatically.

1. Grafana → **Alerting → Contact points → Notification templates**: add a template named
   `devops-agent-payload` (use the JSON template from the AWS doc — maps alert labels/annotations/status).
2. **Contact points → Add contact point → Webhook**: URL = your **DevOps Agent webhook endpoint**,
   set the auth header, and **Custom Payload** = `{{ template "devops-agent-payload" . }}`.
3. **Notification policies**: route the relevant alerts to that webhook contact point.

The on-prem Grafana needs **outbound** access to the DevOps Agent webhook URL (443).

---

## Security considerations

- **Outbound-only**: the relay opens **no inbound** ports on-prem; `cloudflared` dials out to Cloudflare.
- **Read-only**: the built-in connector enables only read tools; keep the SA at **Viewer** (least privilege).
- **TLS**: Cloudflare terminates a valid public certificate; the agent → Cloudflare leg is HTTPS.
- **Token hygiene**: rotate the `glsa_…` token periodically; to update it in the agent, deregister and
  re-register Grafana with the new token.
- **Extra gate (recommended for production)**: put **Cloudflare Access** (or your WAF/IP allowlist) in
  front of the hostname so only authorized callers reach the Grafana login at all.
- **Relay VM hardening**: no inbound services; manage it via your existing patching/SSH-bastion controls.

---

## Limitations

- Quick tunnels (`*.trycloudflare.com`) are **ephemeral** and have no uptime guarantee — test only.
- The built-in Grafana connector is **read-only** (no create/update/delete).
- **ClickHouse** data-source tools are not supported by the connector.
- Proactive incident prevention does not yet use Grafana tools.

---

## Teardown

```bash
# Named tunnel
sudo systemctl disable --now cloudflared
sudo cloudflared service uninstall
cloudflared tunnel delete grafana-devops
# Remove the DNS record in the Cloudflare dashboard.

# Quick tunnel: just stop the cloudflared process.

# In AWS DevOps Agent: Agent Space -> Capabilities -> Telemetry -> Grafana -> Remove,
# then Capability Providers -> Grafana -> Deregister.
# Revoke the Grafana service-account token.
```

---

## Appendix A — Alternative: direct public HTTPS (no Cloudflare)

If your on-prem network *can* open inbound 443 and you have a TLS cert, skip Cloudflare entirely:

1. Put a reverse proxy (nginx/Caddy) in front of Grafana with a **publicly-trusted TLS cert**
   (e.g. Let's Encrypt) on `https://grafana.example.com`.
2. Open inbound **443** on the firewall (optionally restrict source to AWS ranges / add WAF).
3. Register that URL + the `glsa_…` token in the DevOps Agent (Part 4).

Trade-off: simpler data path, but you now manage an inbound public endpoint and its certificate.

---

## Appendix B — How this was validated in the open5gs/EKS lab

The same pattern was proven in this project's lab, where Grafana ran **in EKS** (ClusterIP) instead of
on-prem. The only difference: the relay reached Grafana via `kubectl port-forward` (the in-cluster
equivalent of "reach Grafana over the LAN"). On-prem you skip the port-forward and point `cloudflared`
straight at the Grafana host.

Lab relay (an EC2 with outbound internet, SSM-managed, **egress-only** security group):
```bash
# on the relay host:
kubectl -n monitoring port-forward svc/grafana 3000:3000 --address 127.0.0.1 &   # EKS-only step
cloudflared tunnel --no-autoupdate --url http://localhost:3000
```
Validated end-to-end from the relay's open-internet path (what the agent sees):
```bash
URL=https://<name>.trycloudflare.com ; TOKEN=glsa_xxx
curl -sS -o /dev/null -w "HTTP %{http_code}\n" $URL/api/health                       # 200
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/api/search?type=dash-db"            # lists dashboards
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$URL/api/datasources/proxy/uid/<ds-uid>/api/v1/query?query=up"                    # datasource query
```
