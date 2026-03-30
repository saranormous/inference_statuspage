# Inference Cloud Statuspage

Independent reliability monitoring for AI inference providers: **Baseten**, **Fireworks**, and **Together**.

## Architecture

- `monitor/probe.py` — Synthetic probe. Streams a Kimi K2.5 chat completion (`"Count from 1 to 30"`, 128 max tokens, 30s timeout) to each provider every 5 min. Classifies errors by type (timeout, rate_limit, auth, server_error, client_error, connection). Includes anomaly detection for billing/auth issues. Outputs JSONL.
- `monitor/config.yaml` — Endpoint config (URLs, model IDs, auth, probe settings).
- `site/` — Static site. `index.html`, `app.js`, `styles.css`. No build step.
- `scripts/fetch_incidents.py` — Pulls incident data from provider status feeds.
- `infra/run_probe.sh` — Cron wrapper. Runs the probe, commits and pushes results to `data` branch. Includes lock-file guard against overlapping runs.
- `infra/setup.sh` — Bootstrap script for provisioning a new EC2 probe instance.
- `.github/workflows/probe.yml` — Manual-only (`workflow_dispatch`). Cron schedule disabled; probe runs on EC2 instead.
- `.github/workflows/fetch-incidents.yml` — Fetches incidents every 6 hours, commits to `data` branch.
- `.github/workflows/deploy.yml` — Deploys site to GitHub Pages. Triggers on push to `main` or when probe/incident workflows complete.

### Branch structure
- `main` — Code only. No data files.
- `data` — Orphan branch. Bot commits (probe results, incident data) land here. Keeps ~288 daily probe commits out of code history.
- The deploy workflow checks out both branches, copies `data/parsed/` into `site/parsed/`, then publishes.

## Key design decisions

### Monitoring
- We compare **hosted inference APIs only** — same model (Kimi K2.5), same request, same success criteria.
- Metrics: availability, TTFT p50, latency p50/p95/p99, probe count, failures, error type breakdown.
- Latency sparkline on each card shows p50 trend (line) with p95 band (shaded area) for at-a-glance performance visibility.
- Percentile stats require 20+ successful probes before display.
- Time window toggle: 24h, 7d, 30d.

### Self-reported incidents
- Pulled from each provider's public status feed (BetterStack, Atlassian Statuspage).
- Shown per-provider, **never ranked or compared across providers** — different reporting methodologies make cross-provider comparison misleading.

### Anomaly detection
- The probe automatically detects suspected billing/auth issues and annotates results with an `anomaly` field.
- **Per-provider**: flags `suspected_billing` when a provider shifts from healthy to uniform auth/billing errors (HTTP 401, 402, 403, 412).
- **Cross-provider**: escalates to `suspected_probe_infra` when 2+ providers are flagged simultaneously (likely our infrastructure, not theirs).
- Anomaly-flagged probes are automatically excluded from site aggregates — no manual intervention needed.

### Manual exclusion windows
- `EXCLUSION_WINDOWS` in `site/app.js` lists time periods dropped from aggregates for **all providers** (e.g. billing issues on our side that caused false failures).
- Each entry has `start`, `end` (ISO 8601 UTC), and `reason`.
- Exclusions must apply to all providers equally to keep comparisons fair.
- The raw probe data on the `data` branch is never modified — exclusions are display-only.
- Prefer anomaly detection for new issues; use manual exclusions only for retroactive fixes to historical data.

## Content rules

When editing copy on the site or in this repo:

1. **Keep provider lists in sync.** If a provider is added to or removed from monitoring, update: page title, methodology text, monitoring section labels, config.yaml, and this file.
2. **Never present self-reported incident counts as comparable across providers.** Always include a caveat about different reporting methodologies.
3. **Model name must match reality.** If the probed model changes, update: config.yaml, methodology card, monitoring section label, and this file.
4. **Be neutral to vendors.** No ranking, no "best/worst", no language that implies one provider is better. Present data, let readers decide.

## Running locally

```bash
# Site (requires a local HTTP server for CORS)
cd site && python3 -m http.server 8080

# Probe (needs API keys in env)
source ~/.env
export FIREWORKS_API_KEY TOGETHER_API_KEY BASETEN_API_KEY
python3 monitor/probe.py
```

## Probe infrastructure

The probe runs on a small EC2 instance (`i-06b3615c34d8e53e0`, us-west-1) via cron every 5 minutes. This replaced the GitHub Actions cron schedule, which was unreliable (delays of 5–30 min).

- Instance: `t3.micro`, Amazon Linux 2023
- Cron: `*/5 * * * *` runs `infra/run_probe.sh`
- Auth: deploy key (write access, scoped to this repo only)
- API keys: stored in `~/.env` on the instance
- Logs: `~/probe.log` on the instance
- Code updates: the cron wrapper does `git pull --ff-only` before each run

To SSH in:
```bash
ssh -i ~/Downloads/inference_status_cron.pem ec2-user@54.193.59.209
```

## API keys

Stored in `~/.env` (not committed). Required:
- `FIREWORKS_API_KEY`
- `TOGETHER_API_KEY`
- `BASETEN_API_KEY`
