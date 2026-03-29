#!/usr/bin/env bash
# Cron wrapper — runs the probe and pushes results to the data branch.
# Called every 5 min by crontab.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$REPO_DIR/data-branch"
LOCKFILE="/tmp/statuspage-probe.lock"

# ── Guard against overlapping runs ──
if [ -f "$LOCKFILE" ]; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || true)
  if kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "$(date -u +%FT%TZ)  SKIP — previous probe (pid $LOCK_PID) still running"
    exit 0
  fi
  rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# ── Load API keys ──
set -a
# shellcheck source=/dev/null
source "$HOME/.env"
set +a

# ── Pull latest code (fast-forward only) ──
cd "$REPO_DIR"
git pull --ff-only --quiet 2>/dev/null || true

# ── Pull latest data branch ──
cd "$DATA_DIR"
git pull --rebase --quiet 2>/dev/null || true

# ── Run the probe ──
echo "$(date -u +%FT%TZ)  Probing..."
PROBE_OUTPUT="$DATA_DIR/parsed/probe_results.jsonl" \
  "$REPO_DIR/.venv/bin/python" "$REPO_DIR/monitor/probe.py"

# ── Commit & push ──
cd "$DATA_DIR"
git add parsed/probe_results.jsonl
if git diff --cached --quiet; then
  echo "$(date -u +%FT%TZ)  No changes"
  exit 0
fi

git config user.name "probe-bot"
git config user.email "probe-bot@users.noreply.github.com"
git commit --quiet -m "probe: $(date -u +%FT%TZ)"

for attempt in 1 2 3; do
  git push --quiet && break
  echo "  push failed (attempt $attempt), rebasing..."
  git pull --rebase --quiet
done

echo "$(date -u +%FT%TZ)  Done"
