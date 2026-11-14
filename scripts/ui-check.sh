#!/usr/bin/env bash
# Local UI check against a dev instance (never the deployed UI): starts the sim matcher on
# $SIM_PORT, a web/ dev server on $UI_PORT pointed at it, checks /api/state through the UI's proxy,
# and saves headless screenshots to out/ui-check/ (ui.png = /dashboard; landing-*.png = /; v2-*.png = /v2). Usage: make ui-check [MATCHER_URL=...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Uncommon default ports (cleanup kills whatever listens on them); override with SIM_PORT / UI_PORT.
SIM_PORT="${SIM_PORT:-38791}"; UI_PORT="${UI_PORT:-33091}"
MATCHER_URL="${MATCHER_URL:-http://localhost:$SIM_PORT}"
PIDS=()
mkdir -p "$ROOT/out/ui-check"
if lsof -nP -t -i "tcp:$SIM_PORT" -i "tcp:$UI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ui-check: ports $SIM_PORT/$UI_PORT are busy (a previous run?); free them first" >&2; exit 1
fi
# Next 16 refuses a second dev server per project. Find one by its working directory (not by
# command-line text, which also matches unrelated shells): /proc on Linux, lsof on macOS.
cwd_of() { readlink "/proc/$1/cwd" 2>/dev/null || lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }
for p in $(pgrep -f "next dev" 2>/dev/null || true); do
  if [[ "$(cwd_of "$p")" == "$ROOT/web" ]]; then
    echo "ui-check: a web/ dev server is already running (pid $p). Next allows one per project: stop your web dev server first, then rerun." >&2
    exit 1
  fi
done
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
SHOT="$(find "$HOME/Library/Caches/ms-playwright" -name chrome-headless-shell -type f 2>/dev/null | sort | tail -1 || true)"
if [[ -n "$SHOT" ]]; then
  # Real-time screenshots via the DevTools Protocol (scripts/cdp-shot.mjs, Node built-ins only):
  # the landing page's reveal and WebGL background need real time to finish.
  # Screenshots are diagnostics, not the check: a failed one is retried once, then skipped.
  shot() { # name width height path [waitMs] [fullPage] [reduced] [scroll]
    local args=("$ROOT/scripts/cdp-shot.mjs" "$SHOT" "http://localhost:$UI_PORT$4" "$ROOT/out/ui-check/$1.png" "$2" "$3" "${5:-5000}" "${6:-0}" "${7:-0}" "${8:-0}")
    if out="$(node "${args[@]}" 2>&1)" || out="$(node "${args[@]}" 2>&1)"; then
      echo "ui-check: ${out%%$'\n'*}"
    else
      echo "ui-check: screenshot $1 skipped (${out%%$'\n'*})"
    fi
  }
  # Compile each route before shooting it (a cold dev compile can outlast the screenshot).
  for r in / /dashboard /v2; do curl -s -o /dev/null "http://localhost:$UI_PORT$r" || true; done
  shot ui 1440 900 /dashboard 5000 0                  # the matcher dashboard (was at / before the landing page)
  shot landing-1440 1440 900 /
  shot landing-390 390 844 /
  shot landing-1440-replay 1440 900 / 8000 0 0 "#replay"
  shot landing-390-replay 390 844 / 8000 0 0 "#replay"
  shot landing-1440-reduced 1440 900 / 3000 0 1
  shot v2-1440 1440 900 /v2 6000 0
  shot v2-390 390 844 /v2 6000
else
  echo "ui-check: no headless Chromium found (npx playwright install chromium-headless-shell); skipped screenshot"
fi
