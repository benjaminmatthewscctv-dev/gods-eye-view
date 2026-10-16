#!/usr/bin/env bash
# God's Eye View on the cyberdeck (Pi 5), as the desktop user, no sudo:   bash ~/gods-eye-view/deck/setup.sh
#   1. Node 24 under ~/.nvm (upstream needs >= 24.14; Pi OS ships an older node)
#   2. this fork's `cyberdeck` branch checked out at ~/gods-eye-view (the AI-Cyberdeck bundle's pi/godseye/setup.sh clones it
#      first and then runs this script), npm ci
#   3. the wrapper (vite.deck.config.mjs + godseye.env) at ~/godseye and the .env upstream reads
#   4. the user unit godseye.service on 127.0.0.1:4173
# Re-running is safe: it updates the wrapper and restarts the service; node_modules are rebuilt only when the lockfile changed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
NODE_MAJOR=24

export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "== installing nvm (user-level Node version manager)"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
if ! nvm ls "$NODE_MAJOR" >/dev/null 2>&1; then echo "== installing Node $NODE_MAJOR"; nvm install "$NODE_MAJOR"; fi
nvm use --silent "$NODE_MAJOR"
node -v

cd "$ROOT"
echo "== $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "== npm ci (Cesium is large; a few minutes on the Pi)"; npm ci --no-audit --no-fund
fi

mkdir -p ~/godseye ~/.config/systemd/user
cp "$HERE/vite.deck.config.mjs" "$HERE/aldot_cameras.py" ~/godseye/
python3 ~/godseye/aldot_cameras.py || echo "(ALDOT camera list not refreshed; the previous file, if any, stays)"
[ -f ~/godseye/godseye.env ] || cp "$HERE/godseye.env" ~/godseye/godseye.env       # local edits (keys) survive re-runs
# new settings in deck/godseye.env are appended to the local file (values already there, such as keys, are never changed)
while IFS= read -r line; do k="${line%%=*}"; case "$line" in \#*|"") continue;; esac; grep -q "^$k=" ~/godseye/godseye.env || echo "$line" >> ~/godseye/godseye.env; done < "$HERE/godseye.env"
cp ~/godseye/godseye.env "$ROOT/.env"                                             # upstream reads .env itself (HOST/PORT/keys)
cp "$HERE/godseye.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now godseye.service
systemctl --user restart godseye.service
for i in $(seq 1 40); do curl -sf -m 2 -o /dev/null "http://127.0.0.1:4173/?embed=1" && break; sleep 3; done
echo "godseye: $(systemctl --user is-active godseye.service)  http://127.0.0.1:4173/?embed=1  (MAP tab of the cyberdeck window)"
curl -s -m 5 -X POST http://127.0.0.1:4173/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c 'import sys,json; d=json.load(sys.stdin); print("mcp tools:", len(d.get("result",{}).get("tools",[])))' || echo "mcp: not answering yet"
