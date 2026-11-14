#!/usr/bin/env bash
# Local UI check against a dev instance (never the deployed UI): starts the sim matcher on
# $SIM_PORT, a web/ dev server on $UI_PORT pointed at it, checks /api/state through the UI's proxy,
# and saves a headless screenshot to out/ui-check/ui.png. Usage: make ui-check [MATCHER_URL=...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIM_PORT="${SIM_PORT:-8791}"; UI_PORT="${UI_PORT:-3091}"
MATCHER_URL="${MATCHER_URL:-http://localhost:$SIM_PORT}"
PIDS=()
mkdir -p "$ROOT/out/ui-check"
if lsof -nP -t -i "tcp:$SIM_PORT" -i "tcp:$UI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ui-check: ports $SIM_PORT/$UI_PORT are busy (a previous run?); free them first" >&2; exit 1
fi
if pgrep -f "next dev" >/dev/null && lsof -t "$ROOT/web/.next/dev" >/dev/null 2>&1; then
  echo "ui-check: a web/ dev server is already running (Next allows one per project); stop it first" >&2; exit 1
fi
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  # the subshells' children (tsx, next) outlive their parents: kill whatever holds our ports
  lsof -nP -t -i "tcp:$SIM_PORT" -i "tcp:$UI_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}
trap cleanup EXIT
if [[ "$MATCHER_URL" == "http://localhost:$SIM_PORT" ]]; then
  (cd "$ROOT/apps/matcher" && AGENTS=12 TOKENS=5 SEED=1 SWEEP=0 SERVE=1 ROUND_MS=1500 PORT="$SIM_PORT" OUT_DIR="$ROOT/out/ui-check" pnpm exec tsx src/cli-sim.ts >"$ROOT/out/ui-check/sim.log" 2>&1) &
  PIDS+=($!)
fi
(cd "$ROOT/web" && MATCHER_URL="$MATCHER_URL" npx next dev -p "$UI_PORT" >"$ROOT/out/ui-check/web.log" 2>&1) &
PIDS+=($!)
for i in $(seq 1 60); do curl -sf "http://localhost:$UI_PORT/api/state" >/dev/null 2>&1 && break; sleep 1; done
sleep 8
curl -s "http://localhost:$UI_PORT/api/state" -D "$ROOT/out/ui-check/headers.txt" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);
console.log(`ui-check: source=${d.meta.source} agents=${d.agents.length} rings=${d.rings.length} settled=${d.rings.filter(r=>r.status==="settled").length}`);
if(!d.rings.length){console.error("ui-check: no rings in state");process.exit(1)}})'
SHOT="$(find "$HOME/Library/Caches/ms-playwright" -name chrome-headless-shell -type f 2>/dev/null | sort | tail -1)"
if [[ -n "$SHOT" ]]; then
  "$SHOT" --disable-gpu --window-size=1440,1600 --virtual-time-budget=12000 --screenshot="$ROOT/out/ui-check/ui.png" "http://localhost:$UI_PORT/" >/dev/null 2>&1
  echo "ui-check: screenshot out/ui-check/ui.png"
else
  echo "ui-check: no headless Chromium found (npx playwright install chromium-headless-shell); skipped screenshot"
fi
