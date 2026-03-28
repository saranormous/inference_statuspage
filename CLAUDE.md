# Inference Cloud Statuspage

Independent reliability monitoring for AI inference providers: **Baseten**, **Fireworks**, and **Together**.

## Architecture

- `monitor/probe.py` — Synthetic probe. Streams a Kimi K2.5 chat completion (`"Count from 1 to 30"`, 128 max tokens, 30s timeout) to each provider every 5 min. Classifies errors by type (timeout, rate_limit, auth, server_error, client_error, connection). Outputs JSONL.
- `monitor/config.yaml` — Endpoint config (URLs, model IDs, auth, probe settings).
- `site/` — Static site. `index.html`, `app.js`, `styles.css`. No build step.
- `scripts/fetch_incidents.py` — Pulls incident data from provider status feeds.
- `.github/workflows/probe.yml` — Runs the probe every 5 min, commits to `data` branch.
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
- Percentile stats require 20+ successful probes before display.
- Time window toggle: 24h, 7d, 30d.

### Self-reported incidents
- Pulled from each provider's public status feed (BetterStack, Atlassian Statuspage).
- Shown per-provider, **never ranked or compared across providers** — different reporting methodologies make cross-provider comparison misleading.

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

## API keys

Stored in `~/.env` (not committed). Required:
- `FIREWORKS_API_KEY`
- `TOGETHER_API_KEY`
- `BASETEN_API_KEY`
