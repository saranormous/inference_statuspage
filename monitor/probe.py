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

        return _make_result(
            endpoint,
            status_code=resp.status_code,
            latency_ms=latency_ms,
            ttft_ms=ttft_ms,
            tokens_received=tokens_received,
            success=success,
            error=None if success else f"HTTP {resp.status_code}",
            error_type=None if success else _classify_http_error(resp.status_code),
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
    write_results(results, output_path)
    print(f"Wrote {len(results)} result(s) to {output_path}")


if __name__ == "__main__":
    main()
