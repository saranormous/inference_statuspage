#!/usr/bin/env python3
"""
Synthetic monitoring probe for AI inference API endpoints.

Sends a minimal chat completion request to each configured provider,
measures availability and latency, and appends results as JSONL.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent


def load_config() -> dict:
    """Load and return the probe configuration from config.yaml."""
    config_path = SCRIPT_DIR / "config.yaml"
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def resolve_env_vars(value: str) -> str:
    """Replace ${VAR_NAME} placeholders with environment variable values."""
    def replacer(match):
        var_name = match.group(1)
        return os.environ.get(var_name, "")
    return re.sub(r"\$\{(\w+)\}", replacer, value)


def build_endpoints(config: dict) -> list[dict]:
    """
    Flatten the tier1_inference and tier2_platform sections into a list of
    endpoint descriptors ready to probe.
    """
    endpoints = []

    for provider, cfg in config.get("tier1_inference", {}).items():
        url = resolve_env_vars(cfg["url"])
        if not url:
            continue
        endpoints.append({
            "provider": provider,
            "tier": "inference_api",
            "model": cfg.get("model", ""),
            "url": url,
            "auth_header": cfg["auth_header"],
            "auth_prefix": cfg.get("auth_prefix", "Bearer "),
            "env_key": cfg["env_key"],
        })

    for provider, cfg in config.get("tier2_platform", {}).items():
        url = resolve_env_vars(cfg.get("url", ""))
        if not url:
            continue
        endpoints.append({
            "provider": provider,
            "tier": "platform_canary",
            "model": cfg.get("model", "canary"),
            "url": url,
            "auth_header": cfg["auth_header"],
            "auth_prefix": cfg.get("auth_prefix", "Bearer "),
            "env_key": cfg["env_key"],
        })

    return endpoints


def probe_endpoint(endpoint: dict, settings: dict) -> dict:
    """
    Send a chat completion request to a single endpoint and measure the result.

    Returns a result dict suitable for JSONL output.
    """
    timeout = settings.get("timeout_seconds", 30)
    prompt_msg = settings.get("prompt_message", "Count from 1 to 30, one number per line.")
    max_tokens = settings.get("max_tokens", 128)
    stream = settings.get("stream", True)

    api_key = os.environ.get(endpoint["env_key"], "")
    if not api_key:
        return _make_result(
            endpoint,
            status_code=0,
            latency_ms=0,
            ttft_ms=None,
            tokens_received=0,
            success=False,
            error=f"Missing env var: {endpoint['env_key']}",
            error_type="config",
        )

    headers = {
        "Content-Type": "application/json",
        endpoint["auth_header"]: f"{endpoint['auth_prefix']}{api_key}",
    }

    body = {
        "messages": [{"role": "user", "content": prompt_msg}],
        "max_tokens": max_tokens,
        "stream": stream,
    }
    if endpoint["model"] and endpoint["tier"] == "inference_api":
        body["model"] = endpoint["model"]

    t_start = time.monotonic()
    ttft_ms = None
    tokens_received = 0

    try:
        resp = requests.post(
            endpoint["url"],
            headers=headers,
            json=body,
            timeout=timeout,
            stream=stream,
        )

        if stream and resp.status_code == 200:
            # Consume full stream to measure TTFT vs total latency
            for line in resp.iter_lines():
                if line:
                    decoded = line.decode("utf-8", errors="replace")
                    if decoded.startswith("data:") and "[DONE]" not in decoded:
                        if ttft_ms is None:
                            ttft_ms = _elapsed_ms(t_start)
                        tokens_received += 1
            resp.close()
        elif not stream and resp.status_code == 200:
            data = resp.json()
            usage = data.get("usage", {})
            tokens_received = usage.get("completion_tokens", 0)

        latency_ms = _elapsed_ms(t_start)
        success = resp.status_code == 200

        error_detail = None
        if not success:
            try:
                error_detail = resp.text[:500]
            except Exception:
                pass

        return _make_result(
            endpoint,
            status_code=resp.status_code,
            latency_ms=latency_ms,
            ttft_ms=ttft_ms,
            tokens_received=tokens_received,
            success=success,
            error=None if success else f"HTTP {resp.status_code}",
            error_type=None if success else _classify_http_error(resp.status_code),
            error_detail=error_detail,
        )

    except requests.exceptions.Timeout:
        return _make_result(
            endpoint,
            status_code=0,
            latency_ms=_elapsed_ms(t_start),
            ttft_ms=None,
            tokens_received=0,
            success=False,
            error="timeout",
            error_type="timeout",
        )
    except requests.exceptions.ConnectionError as exc:
        return _make_result(
            endpoint,
            status_code=0,
            latency_ms=_elapsed_ms(t_start),
            ttft_ms=None,
            tokens_received=0,
            success=False,
            error=f"connection_error: {exc}",
            error_type="connection",
        )
    except Exception as exc:
        return _make_result(
            endpoint,
            status_code=0,
            latency_ms=_elapsed_ms(t_start),
            ttft_ms=None,
            tokens_received=0,
            success=False,
            error=str(exc),
            error_type="unknown",
        )


def _classify_http_error(status_code: int) -> str:
    """Classify HTTP error into a category for aggregation."""
    if status_code == 429:
        return "rate_limit"
    if status_code in (401, 403):
        return "auth"
    if 400 <= status_code < 500:
        return "client_error"
    if 500 <= status_code < 600:
        return "server_error"
    return "unknown"


def _elapsed_ms(t_start: float) -> int:
    """Milliseconds elapsed since t_start (monotonic)."""
    return int((time.monotonic() - t_start) * 1000)


def detect_probe_region() -> str:
    """Best-effort probe region detection for transparency."""
    # GitHub Actions sets these
    region = os.environ.get("GITHUB_ACTIONS_REGION") or os.environ.get("RUNNER_REGION")
    if region:
        return region
    # Fallback: check common cloud metadata or env hints
    if os.environ.get("GITHUB_ACTIONS"):
        return "GitHub Actions (US)"
    if os.environ.get("AWS_REGION"):
        return os.environ["AWS_REGION"]
    return "local"


def _make_result(endpoint: dict, **kwargs) -> dict:
    """Build a standardised result dict."""
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "provider": endpoint["provider"],
        "tier": endpoint["tier"],
        "model": endpoint.get("model", ""),
        "endpoint": endpoint["url"],
        "probe_region": detect_probe_region(),
        **kwargs,
    }


def write_results(results: list[dict], output_path: Path) -> None:
    """Append result dicts as JSONL to the output file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "a") as f:
        for r in results:
            f.write(json.dumps(r, default=str) + "\n")


# ── Anomaly detection ──────────────────────────────────────────────
# Auth/billing error codes — these almost never indicate a real outage.
_AUTH_BILLING_CODES = {401, 402, 403, 412}

# How many recent probes per provider to look back at.
_LOOKBACK = 6  # ~30 min at 5-min intervals


def _read_recent_results(output_path: Path, providers: set[str]) -> dict[str, list[dict]]:
    """Read the tail of the JSONL file and return recent results per provider."""
    by_provider: dict[str, list[dict]] = {p: [] for p in providers}
    if not output_path.exists():
        return by_provider
    # Read last ~50 lines (enough for 3 providers * 6 lookback + margin)
    try:
        lines = output_path.read_text().strip().splitlines()[-50:]
    except Exception:
        return by_provider
    for line in lines:
        try:
            r = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        p = r.get("provider")
        if p in by_provider:
            by_provider[p].append(r)
    # Keep only the most recent _LOOKBACK per provider
    for p in by_provider:
        by_provider[p] = by_provider[p][-_LOOKBACK:]
    return by_provider


def detect_anomalies(
    current_results: list[dict],
    history: dict[str, list[dict]],
) -> None:
    """
    Annotate each result with an 'anomaly' field when the failure pattern
    looks like a billing or auth issue rather than a real provider outage.

    Detection heuristics:
    1. Per-provider: provider was recently healthy but now shows uniform
       failures with an auth/billing HTTP code.
    2. Cross-provider: multiple providers failing simultaneously with
       auth-like codes — almost certainly our infrastructure, not theirs.
    """
    # Group current results by provider
    current_by_provider: dict[str, dict] = {}
    for r in current_results:
        current_by_provider[r["provider"]] = r

    # Per-provider detection
    flagged_providers = set()
    for r in current_results:
        if r["success"]:
            r["anomaly"] = None
            continue

        provider = r["provider"]
        status_code = r.get("status_code", 0)
        hist = history.get(provider, [])

        # Check if this is an auth/billing code
        if status_code not in _AUTH_BILLING_CODES:
            r["anomaly"] = None
            continue

        # Was this provider recently healthy? (any success in lookback)
        recent_successes = sum(1 for h in hist if h.get("success"))
        if not hist or recent_successes > 0:
            # Went from healthy to auth/billing error — suspicious
            flagged_providers.add(provider)
            r["anomaly"] = "suspected_billing"
        else:
            # Has been failing for a while with this code — still flag it
            # but with lower confidence
            recent_codes = {h.get("status_code") for h in hist if not h.get("success")}
            if recent_codes == {status_code}:
                flagged_providers.add(provider)
                r["anomaly"] = "suspected_billing"
            else:
                r["anomaly"] = None

    # Cross-provider: if 2+ providers are flagged, escalate to infra-level
    if len(flagged_providers) >= 2:
        for r in current_results:
            if r.get("anomaly") == "suspected_billing":
                r["anomaly"] = "suspected_probe_infra"


def main() -> None:
    config = load_config()
    settings = config.get("probe_settings", {})
    endpoints = build_endpoints(config)

    if not endpoints:
        print("No endpoints resolved — check config.yaml and env vars.", file=sys.stderr)
        sys.exit(1)

    print(f"Probing {len(endpoints)} endpoint(s)...")

    results = []
    for ep in endpoints:
        label = f"{ep['tier']}/{ep['provider']}"
        print(f"  {label} ...", end=" ", flush=True)
        result = probe_endpoint(ep, settings)
        status = "OK" if result["success"] else result.get("error", "FAIL")
        print(f"{result['latency_ms']}ms — {status}")
        results.append(result)

    output_override = os.environ.get("PROBE_OUTPUT")
    if output_override:
        output_path = Path(output_override)
    else:
        output_rel = settings.get("output_file", "parsed/probe_results.jsonl")
        output_path = REPO_ROOT / output_rel

    # Detect anomalies before writing
    providers = {r["provider"] for r in results}
    history = _read_recent_results(output_path, providers)
    detect_anomalies(results, history)

    for r in results:
        if r.get("anomaly"):
            print(f"  ⚠ {r['provider']}: {r['anomaly']} (HTTP {r.get('status_code')})")

    write_results(results, output_path)
    print(f"Wrote {len(results)} result(s) to {output_path}")


if __name__ == "__main__":
    main()
