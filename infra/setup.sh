#!/usr/bin/env bash
# Bootstrap script — run once on a fresh EC2 Amazon Linux 2023 / Ubuntu instance.
# Usage:  ssh into the box, then:
#   curl -sSf https://raw.githubusercontent.com/<owner>/statuspage/main/infra/setup.sh | bash
#   — OR — paste the contents and run manually.
set -euo pipefail

REPO_URL="https://github.com/sarahguo/statuspage.git"   # <-- update if different
INSTALL_DIR="$HOME/statuspage"

echo "=== 1/5  Installing system packages ==="
if command -v apt-get &>/dev/null; then
  sudo apt-get update -qq && sudo apt-get install -y -qq python3 python3-pip python3-venv git cron
elif command -v dnf &>/dev/null; then
  sudo dnf install -y python3 python3-pip git cronie && sudo systemctl enable --now crond
fi

echo "=== 2/5  Cloning repo ==="
if [ -d "$INSTALL_DIR" ]; then
  echo "  (already exists, pulling latest)"
  cd "$INSTALL_DIR" && git pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

echo "=== 3/5  Python venv + deps ==="
python3 -m venv .venv
.venv/bin/pip install --quiet -r monitor/requirements.txt

echo "=== 4/5  Checking out data branch ==="
if [ ! -d "$INSTALL_DIR/data-branch" ]; then
  git worktree add data-branch data
fi

echo "=== 5/5  Installing crontab ==="
CRON_LINE="*/5 * * * * $INSTALL_DIR/infra/run_probe.sh >> $HOME/probe.log 2>&1"
( crontab -l 2>/dev/null | grep -v run_probe.sh; echo "$CRON_LINE" ) | crontab -

echo ""
echo "Done!  Next steps:"
echo "  1. Create ~/.env with your API keys:"
echo "       FIREWORKS_API_KEY=..."
echo "       TOGETHER_API_KEY=..."
echo "       BASETEN_API_KEY=..."
echo "  2. Set up git push credentials (deploy key or token):"
echo "       git config --global credential.helper store"
echo "       (then do a test push, or add a deploy key)"
echo "  3. Verify with:  bash $INSTALL_DIR/infra/run_probe.sh"
echo "  4. Tail the log:  tail -f ~/probe.log"
