#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
AGENT_CONFIG=$(cat "$ROOT/agent-config.json")

cleanup() {
  echo ""
  echo "[start] Shutting down..."
  [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null
  wait 2>/dev/null
  echo "[start] Done."
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "[start] Building..."
cd "$ROOT" && npm run build

echo "[start] Starting gateway (WS :$(jq -r .wsPort gateway-config.json))..."
npx tsx packages/gateway/src/index.ts &
GATEWAY_PID=$!

echo "[start] Starting agent (device: $(echo "$AGENT_CONFIG" | jq -r .device))..."
AGENT_CONFIG="$AGENT_CONFIG" npx tsx packages/agent/src/index.ts &
AGENT_PID=$!

echo "[start] Gateway PID=$GATEWAY_PID  Agent PID=$AGENT_PID"
echo "[start] Both services running. Press Ctrl+C to stop."
wait
