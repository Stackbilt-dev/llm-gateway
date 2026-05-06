#!/usr/bin/env bash
# Launch Claude Code routed through the local LLM gateway.
# Starts the gateway automatically if it isn't running.
# Usage: ./claude-gateway.sh [claude args...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_URL="http://localhost:8787"
GATEWAY_KEY="${STACKBILT_GATEWAY_KEY:-local-dev-key}"

start_gateway() {
  echo "[gateway] starting..."
  bash "$SCRIPT_DIR/start-gateway.sh" > /tmp/llm-gateway.log 2>&1 &
  local pid=$!

  local tries=0
  while (( tries < 15 )); do
    if curl -sf "$GATEWAY_URL/health" > /dev/null 2>&1; then
      echo "[gateway] up (pid $pid)"
      return 0
    fi
    sleep 1
    (( tries++ ))
  done

  echo "[gateway] ERROR: failed to start — check /tmp/llm-gateway.log"
  exit 1
}

# Start gateway if not already running
if ! curl -sf "$GATEWAY_URL/health" > /dev/null 2>&1; then
  start_gateway
else
  echo "[gateway] already running at $GATEWAY_URL"
fi

echo "[gateway] routing Claude Code through $GATEWAY_URL"
exec env \
  ANTHROPIC_BASE_URL="$GATEWAY_URL" \
  ANTHROPIC_API_KEY="$GATEWAY_KEY" \
  claude "$@"
