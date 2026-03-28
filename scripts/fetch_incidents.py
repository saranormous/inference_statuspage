#!/usr/bin/env python3
"""Fetch and normalize incident data from AI infra provider status pages."""

import json
import csv
import os
import sys
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.request import urlopen, Request
from xml.etree import ElementTree as ET

PARSED_DIR = Path(os.environ.get("PARSED_DIR", Path(__file__).resolve().parent.parent / "parsed"))

PROVIDERS = {
    "fireworks": {
        "name": "Fireworks AI",
        "feed_type": "betterstack_simple",
        "feed_url": "https://status.fireworks.ai/feed.atom",
        "status_url": "https://status.fireworks.ai",
        "components": [
            "Fireworks AI website",
            "Llama 3.3 70B Instruct",
            "Kimi K2 Instruct 0905",
            "Kimi K2 Thinking",
            "OpenAI GPT OSS 120B",
            "OpenAI GPT OSS 20B",
            "DeepSeek v3p1",
            "Nomic Embed Text v1.5",
            "Qwen3 Embedding 8B",
            "Qwen3 VL 30B A3B Thinking",
        ],
    },
    "modal": {
        "name": "Modal",
        "feed_type": "betterstack_incident",
        "feed_url": "https://status.modal.com/feed.atom",
        "status_url": "https://status.modal.com",
        "components": [
            "CPU functions",
            "GPU functions",
            "Web endpoints",
            "Snapshot restores",
            "Frontend",
            "Web API",
            "Volumes",
            "Sandboxes",
            "Image builds",
            "OIDC Endpoint",
        ],
    },
    "together": {
        "name": "Together AI",
        "feed_type": "betterstack_simple",
        "feed_url": "https://status.together.ai/feed.atom",
        "status_url": "https://status.together.ai",
        "components": [
            "Website",
            "Playground",
            "Inference - Chat",
            "Inference - Vision",
            "Inference - Language",
            "Inference - Images",
            "Inference - Embeddings",
            "Inference - Rerank",
            "Inference - Voice",
            "Inference - Moderation",
        ],
    },
    "baseten": {
        "name": "Baseten",
        "feed_type": "statuspage",
        "api_url": "https://status.baseten.co/api/v2/incidents.json",
        "status_url": "https://status.baseten.co",
        "components": [
            "Dedicated Inference",
            "Model APIs",
            "Training",
            "Model Management API",
            "Web Application",
            "Homepage and Docs",
        ],
    },
}


def fetch_url(url):
    """Fetch URL content as text."""
    req = Request(url, headers={"User-Agent": "statuspage-fetcher/1.0"})
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def parse_rfc2822(s):
    """Parse RFC 2822 date (used in RSS pubDate). Always returns UTC-aware."""
    if not s:
        return None
    try:
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def parse_iso(s):
    """Parse an ISO 8601 datetime string."""
    if not s:
        return None
    s = s.strip()
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def to_iso(dt):
    """Convert datetime to ISO 8601 string."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def classify_impact(duration_minutes):
    """Classify impact based on duration."""
    if duration_minutes >= 60:
        return "major"
    return "minor"


def parse_rss_items(xml_text):
    """Parse RSS <item> elements from BetterStack feeds."""
    root = ET.fromstring(xml_text)
    items = root.findall(".//item")
    parsed = []
    for item in items:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        guid = (item.findtext("guid") or "").strip()
        desc = (item.findtext("description") or "").strip()

        dt = parse_rfc2822(pub_date)
        if not dt or not title:
            continue

        parsed.append({
            "title": title,
            "link": link,
            "pub_date": dt,
            "guid": guid,
            "description": desc,
        })

    parsed.sort(key=lambda x: x["pub_date"])
    return parsed


def parse_betterstack_simple(xml_text, provider_key):
    """Parse BetterStack simple up/down feed (Fireworks, Together).

    Entries are like: "ServiceName went down" / "ServiceName recovered"
    """
    items = parse_rss_items(xml_text)
    open_incidents = {}
    incidents = []
    counter = 0

    for item in items:
        title = item["title"]
        title_lower = title.lower()

        if " went down" in title_lower:
            service = re.sub(r"\s+went down$", "", title, flags=re.IGNORECASE).strip()
            open_incidents[service] = item
        elif " recovered" in title_lower:
            service = re.sub(r"\s+recovered$", "", title, flags=re.IGNORECASE).strip()
            if service in open_incidents:
                down = open_incidents.pop(service)
                counter += 1
                start_dt = down["pub_date"]
                end_dt = item["pub_date"]
                duration = max(0, int((end_dt - start_dt).total_seconds() / 60))

                incidents.append({
                    "id": f"{provider_key}_{counter}",
                    "title": f"{service} outage",
                    "url": item["link"],
                    "published_at": to_iso(start_dt),
                    "updated_at": to_iso(end_dt),
                    "status_sequence": ["Investigating", "Resolved"],
                    "started_at": to_iso(start_dt),
                    "resolved_at": to_iso(end_dt),
                    "downtime_start": to_iso(start_dt),
                    "downtime_end": to_iso(end_dt),
                    "duration_minutes": duration,
                    "updates": [
                        {"at": to_iso(start_dt), "status": "Investigating",
                         "message": f"{service} went down"},
                        {"at": to_iso(end_dt), "status": "Resolved",
                         "message": f"{service} recovered"},
                    ],
                    "impact": classify_impact(duration),
                    "components": [service],
                    "provider": provider_key,
                })

    return incidents


def parse_betterstack_incident(xml_text, provider_key):
    """Parse BetterStack incident-style feed (Modal).

    Entries share a link (incident URL) with multiple update descriptions.
    """
    items = parse_rss_items(xml_text)

    # Group by incident link
    incident_groups = {}
    for item in items:
        link = item["link"]
        if link not in incident_groups:
            incident_groups[link] = []
        incident_groups[link].append(item)

    incidents = []
    counter = 0

    for link, group in incident_groups.items():
        group.sort(key=lambda x: x["pub_date"])
        if not group:
            continue

        counter += 1
        first = group[0]
        last = group[-1]
        title = first["title"]

        start_dt = first["pub_date"]
        end_dt = last["pub_date"]
        duration = max(0, int((end_dt - start_dt).total_seconds() / 60))

        # Determine if resolved
        last_desc = last["description"].lower()
        is_resolved = any(kw in last_desc for kw in ["resolved", "recovered", "fixed", "back to normal"])

        status_seq = []
        updates = []
        for item in group:
            desc = item["description"]
            if "investigating" in desc.lower():
                status = "Investigating"
            elif "resolved" in desc.lower() or "recovered" in desc.lower():
                status = "Resolved"
            elif "monitoring" in desc.lower():
                status = "Monitoring"
            else:
                status = "Update"
            status_seq.append(status)
            updates.append({
                "at": to_iso(item["pub_date"]),
                "status": status,
                "message": desc,
            })

        # Infer components from title
        components = infer_components(title, PROVIDERS[provider_key]["components"])

        impact = "major" if duration >= 60 else "minor"
        if any(kw in title.lower() for kw in ["degraded", "elevated latency", "slow"]):
            impact = "minor"
        if any(kw in title.lower() for kw in ["down", "unavailable", "outage"]):
            impact = "major"

        incidents.append({
            "id": f"{provider_key}_{counter}",
            "title": title,
            "url": link,
            "published_at": to_iso(start_dt),
            "updated_at": to_iso(end_dt),
            "status_sequence": status_seq,
            "started_at": to_iso(start_dt),
            "resolved_at": to_iso(end_dt) if is_resolved else None,
            "downtime_start": to_iso(start_dt),
            "downtime_end": to_iso(end_dt),
            "duration_minutes": duration,
            "updates": updates,
            "impact": impact,
            "components": components,
            "provider": provider_key,
        })

    return incidents


def infer_components(title, known_components):
    """Try to match incident title to known components."""
    title_lower = title.lower()
    matched = []
    for comp in known_components:
        if comp.lower() in title_lower:
            matched.append(comp)
    # Also try keyword matching
    keyword_map = {
        "sandbox": "Sandboxes",
        "image build": "Image builds",
        "volume": "Volumes",
        "gpu": "GPU functions",
        "cpu": "CPU functions",
        "web endpoint": "Web endpoints",
        "function call": "CPU functions",
        "container scheduling": "GPU functions",
        "oidc": "OIDC Endpoint",
        "frontend": "Frontend",
        "web api": "Web API",
        "snapshot": "Snapshot restores",
    }
    for kw, comp in keyword_map.items():
        if kw in title_lower and comp not in matched and comp in known_components:
            matched.append(comp)

    return matched if matched else []


def parse_statuspage_api(json_text, provider_key):
    """Parse Atlassian Statuspage API JSON into normalized incidents."""
    data = json.loads(json_text)
    raw_incidents = data.get("incidents", [])
    incidents = []

    for raw in raw_incidents:
        status_seq = []
        updates = []
        for upd in reversed(raw.get("incident_updates", [])):
            status = upd.get("status", "").capitalize()
            if status:
                status_seq.append(status)
            updates.append({
                "at": upd.get("display_at") or upd.get("created_at", ""),
                "status": status,
                "message": upd.get("body", ""),
            })

        components = [c["name"] for c in raw.get("components", [])]
        impact = raw.get("impact", "none")
        if impact == "critical":
            impact = "major"

        started = raw.get("started_at") or raw.get("created_at", "")
        resolved = raw.get("resolved_at")

        start_dt = parse_iso(started)
        end_dt = parse_iso(resolved) if resolved else None
        duration = 0
        if start_dt and end_dt:
            duration = int((end_dt - start_dt).total_seconds() / 60)

        incidents.append({
            "id": f"{provider_key}_{raw['id']}",
            "title": raw.get("name", "Incident"),
            "url": raw.get("shortlink", ""),
            "published_at": raw.get("created_at", started),
            "updated_at": raw.get("updated_at", ""),
            "status_sequence": status_seq or ["Resolved"],
            "started_at": started,
            "resolved_at": resolved,
            "downtime_start": started,
            "downtime_end": resolved or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "duration_minutes": duration,
            "updates": updates,
            "impact": impact,
            "components": components,
            "provider": provider_key,
        })

    return incidents


def fetch_provider(key, config):
    """Fetch incidents for a single provider."""
    print(f"  Fetching {config['name']}...")
    try:
        if config["feed_type"] == "betterstack_simple":
            text = fetch_url(config["feed_url"])
            return parse_betterstack_simple(text, key)
        elif config["feed_type"] == "betterstack_incident":
            text = fetch_url(config["feed_url"])
            return parse_betterstack_incident(text, key)
        elif config["feed_type"] == "statuspage":
            text = fetch_url(config["api_url"])
            return parse_statuspage_api(text, key)
    except Exception as e:
        print(f"  ERROR fetching {config['name']}: {e}", file=sys.stderr)
        return []


def main():
    PARSED_DIR.mkdir(parents=True, exist_ok=True)

    all_incidents = {}
    all_windows = []

    for key, config in PROVIDERS.items():
        incidents = fetch_provider(key, config)
        all_incidents[key] = incidents
        print(f"  -> {len(incidents)} incidents for {config['name']}")

        # Write per-provider JSONL
        jsonl_path = PARSED_DIR / f"{key}_incidents.jsonl"
        with open(jsonl_path, "w") as f:
            for inc in sorted(incidents, key=lambda x: x.get("published_at", "")):
                f.write(json.dumps(inc) + "\n")

        # Build downtime windows
        for inc in incidents:
            if inc.get("downtime_start") and inc.get("downtime_end"):
                all_windows.append({
                    "provider": key,
                    "incident_id": inc["id"],
                    "downtime_start": inc["downtime_start"],
                    "downtime_end": inc["downtime_end"],
                    "duration_minutes": inc.get("duration_minutes", 0),
                    "source": "feed",
                    "title": inc["title"],
                    "impact": inc.get("impact", "none"),
                    "components": ",".join(inc.get("components", [])),
                })

    # Write combined JSONL
    combined_path = PARSED_DIR / "incidents.jsonl"
    with open(combined_path, "w") as f:
        combined = []
        for incidents in all_incidents.values():
            combined.extend(incidents)
        combined.sort(key=lambda x: x.get("published_at", ""))
        for inc in combined:
            f.write(json.dumps(inc) + "\n")

    # Write downtime windows CSV
    windows_path = PARSED_DIR / "downtime_windows.csv"
    with open(windows_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "provider", "incident_id", "downtime_start", "downtime_end",
            "duration_minutes", "source", "title", "impact", "components",
        ])
        writer.writeheader()
        for w in sorted(all_windows, key=lambda x: x["downtime_start"]):
            writer.writerow(w)

    # Write provider metadata JSON
    meta = {}
    for key, config in PROVIDERS.items():
        meta[key] = {
            "name": config["name"],
            "status_url": config["status_url"],
            "components": config["components"],
            "incident_count": len(all_incidents.get(key, [])),
        }
    meta_path = PARSED_DIR / "providers.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    total = sum(len(v) for v in all_incidents.values())
    print(f"\nDone! {total} total incidents written to {PARSED_DIR}")


if __name__ == "__main__":
    main()
