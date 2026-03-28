# Inference Cloud Statuspage

If you're picking between Baseten, Fireworks, and Together for inference, you probably want to know how reliable they actually are. Their status pages don't help — they use different platforms, report at different granularities, and define "incident" differently. You can't compare them directly.

So we built a probe that sends the same request to all three every 5 minutes (Kimi K2.5, `"Count from 1 to 30"`, streaming, 128 max tokens, 30s timeout) and records: availability, time to first token, total latency, and error type on failure.

We also pull each provider's public status feed and show it per-provider. These aren't comparable across providers — different reporting platforms, different granularity, different disclosure practices. The fact that providers don't even all expose basic incident history is part of why this project exists.

All three providers offer Kimi K2.5 as a serverless endpoint, which is what we test. Production workloads typically run on dedicated deployments — this measures the shared, on-demand tier.

**[Live site →](https://saranormous.github.io/inference_statuspage)**

## What's here

```
site/            Static site (no build step)
monitor/         Synthetic probe (Python)
scripts/         Incident data fetcher
.github/         GitHub Actions workflows (probe every 5 min, incidents every 6h)
```

Probe results and incident data live on the `data` branch (separate from code history).

## Run it yourself

```bash
# Serve the site
cd site && python3 -m http.server 8080

# Run the probe
export FIREWORKS_API_KEY=...
export TOGETHER_API_KEY=...
export BASETEN_API_KEY=...
pip install -r monitor/requirements.txt
python monitor/probe.py
```

## Caveats

- Probes run from one location (GitHub Actions, US). Latency is relative to that, not global.
- One request every 5 min can hit cold starts. This measures baseline availability, not throughput.
- Kimi K2.5 is a thinking model — response times include reasoning overhead we don't control.
- Each provider may use different hardware, quantization, or batching behind the same model name.
- Percentile stats require 20+ probes before they show up.
- Self-reported incident counts are not comparable across providers.

## License

MIT
