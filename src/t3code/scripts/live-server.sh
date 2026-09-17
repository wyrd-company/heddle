#!/usr/bin/env bash
# ---
# relationships:
#   verifies:
#     - t3-code-client
#     - agent-tools
# ---
# Start (or stop) a throwaway T3 Code server for live tests and print env exports.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.t3-live"
T3_BIN="${T3_BIN:-/workspaces/worktrees/t3code/mcp-external-registration/apps/server/dist/bin.mjs}"
PORT="${T3_PORT:-3979}"

if [[ "${1:-start}" == "stop" ]]; then
  if [[ -f "$STATE/pid" ]]; then kill "$(cat "$STATE/pid")" 2>/dev/null || true; rm -f "$STATE/pid"; fi
  echo "stopped" >&2
  exit 0
fi

mkdir -p "$STATE/home" "$STATE/workspace"
if [[ -f "$STATE/pid" ]] && kill -0 "$(cat "$STATE/pid")" 2>/dev/null; then
  echo "already running (pid $(cat "$STATE/pid"))" >&2
else
  nohup node "$T3_BIN" serve --port "$PORT" --host 127.0.0.1 --base-dir "$STATE/home" \
    --log-level warn "$STATE/workspace" > "$STATE/server.log" 2>&1 &
  echo $! > "$STATE/pid"
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/.well-known/t3/environment" > /dev/null 2>&1 && break
    sleep 0.5
  done
fi
TOKEN="$(node "$T3_BIN" auth session issue --base-dir "$STATE/home" --label live-tests --token-only 2>/dev/null | tr -d '[:space:]')"
echo "export T3_LIVE=1"
echo "export T3_LIVE_URL=http://127.0.0.1:$PORT"
echo "export T3_LIVE_TOKEN=$TOKEN"
echo "export T3_LIVE_HOME=$STATE/home"
echo "export T3_LIVE_WORKSPACE=$STATE/workspace"
echo "export T3_BIN=$T3_BIN"
