#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/start-gateway.sh"
PID_FILE="${GATEWAY_PID_FILE:-/tmp/llm-gateway.pid}"
LOG_FILE="${GATEWAY_LOG_FILE:-/tmp/llm-gateway.log}"
PORT="${STACKBILT_GATEWAY_PORT:-8787}"
GATEWAY_URL="http://localhost:${PORT}"
GATEWAY_KEY="${STACKBILT_GATEWAY_KEY:-local-dev-key}"
ENV_FILE="${SCRIPT_DIR}/.env"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gateway] ERROR: missing required command: $1"
    exit 1
  fi
}

load_env_if_present() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    touch "$ENV_FILE"
  fi
}

upsert_env_key() {
  local key="$1"
  local value="$2"
  ensure_env_file
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "$ENV_FILE"
  else
    printf "%s=%s\n" "$key" "$value" >>"$ENV_FILE"
  fi
}

prompt_key_if_missing() {
  local key="$1"
  local label="$2"
  local current="${!key:-}"
  if [[ -n "$current" ]]; then
    echo "[init] ${key} already set"
    return 0
  fi

  printf "%s (leave blank to skip): " "$label"
  local value
  read -r value
  if [[ -n "$value" ]]; then
    upsert_env_key "$key" "$value"
    export "$key=$value"
    echo "[init] saved ${key}"
  else
    echo "[init] skipped ${key}"
  fi
}

is_healthy() {
  curl -sf "${GATEWAY_URL}/health" >/dev/null 2>&1
}

is_pid_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

start_gateway() {
  require_cmd curl

  if is_healthy; then
    echo "[gateway] already running at ${GATEWAY_URL}"
    return 0
  fi

  if is_pid_running; then
    local stale_pid
    stale_pid="$(cat "$PID_FILE")"
    echo "[gateway] found running pid ${stale_pid} but healthcheck failed; restarting"
    kill "$stale_pid" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi

  echo "[gateway] starting on port ${PORT}..."
  STACKBILT_GATEWAY_PORT="$PORT" bash "$START_SCRIPT" --port "$PORT" >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"

  local tries=0
  while (( tries < 20 )); do
    if is_healthy; then
      echo "[gateway] up (pid ${pid})"
      return 0
    fi
    sleep 1
    ((tries++))
  done

  echo "[gateway] ERROR: failed to start"
  echo "[gateway] log: ${LOG_FILE}"
  rm -f "$PID_FILE"
  exit 1
}

stop_gateway() {
  if ! is_pid_running; then
    if is_healthy; then
      echo "[gateway] running at ${GATEWAY_URL}, but no pid file at ${PID_FILE}"
      echo "[gateway] nothing to stop safely"
      return 1
    fi
    echo "[gateway] not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  echo "[gateway] stopping pid ${pid}..."
  kill "$pid" >/dev/null 2>&1 || true

  local tries=0
  while (( tries < 10 )); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      break
    fi
    sleep 1
    ((tries++))
  done

  rm -f "$PID_FILE"
  echo "[gateway] stopped"
}

status_gateway() {
  local status="down"
  if is_healthy; then
    status="up"
  fi

  echo "status=${status}"
  echo "url=${GATEWAY_URL}"
  echo "pid_file=${PID_FILE}"
  echo "log_file=${LOG_FILE}"

  if is_pid_running; then
    echo "pid=$(cat "$PID_FILE")"
  else
    echo "pid=none"
  fi
}

show_logs() {
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "[gateway] no log file at ${LOG_FILE}"
    return 0
  fi
  tail -n 120 "$LOG_FILE"
}

doctor() {
  local failures=0
  local warnings=0

  echo "[doctor] gateway quick checks"

  load_env_if_present

  if command -v node >/dev/null 2>&1; then
    echo "[ok] node found: $(node -v)"
  else
    echo "[fail] node is required"
    failures=$((failures + 1))
  fi

  if command -v npm >/dev/null 2>&1; then
    echo "[ok] npm found: $(npm -v)"
  else
    echo "[fail] npm is required"
    failures=$((failures + 1))
  fi

  if command -v curl >/dev/null 2>&1; then
    echo "[ok] curl found"
  else
    echo "[fail] curl is required"
    failures=$((failures + 1))
  fi

  if [[ -f "$ENV_FILE" ]]; then
    echo "[ok] .env file found"
  else
    echo "[fail] missing .env at $ENV_FILE"
    failures=$((failures + 1))
  fi

  local provider_count=0
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "[ok] anthropic configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    echo "[ok] openai configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${GROQ_API_KEY:-}" ]]; then
    echo "[ok] groq configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${CEREBRAS_API_KEY:-}" ]]; then
    echo "[ok] cerebras configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "[ok] cloudflare configured via account+token"
    provider_count=$((provider_count + 1))
  fi

  if (( provider_count == 0 )); then
    echo "[fail] no providers configured in environment"
    echo "       set at least one: ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, or CLOUDFLARE_ACCOUNT_ID+CLOUDFLARE_API_TOKEN"
    failures=$((failures + 1))
  fi

  if command -v claude >/dev/null 2>&1; then
    echo "[ok] claude cli found"
  else
    echo "[warn] claude cli not found (needed for 'gateway.sh claude')"
    warnings=$((warnings + 1))
  fi

  if command -v codex >/dev/null 2>&1; then
    echo "[ok] codex cli found"
  else
    echo "[warn] codex cli not found (needed for 'gateway.sh codex')"
    warnings=$((warnings + 1))
  fi

  echo "[doctor] gateway url: ${GATEWAY_URL}"
  echo "[doctor] gateway key: ${GATEWAY_KEY:+set}"
  echo "[doctor] checks complete: failures=${failures}, warnings=${warnings}"

  if (( failures > 0 )); then
    return 1
  fi
}

init() {
  echo "[init] configuring gateway provider keys in ${ENV_FILE}"
  load_env_if_present
  ensure_env_file

  prompt_key_if_missing "GROQ_API_KEY" "Groq API key"
  prompt_key_if_missing "CEREBRAS_API_KEY" "Cerebras API key"
  prompt_key_if_missing "ANTHROPIC_API_KEY" "Anthropic API key"
  prompt_key_if_missing "OPENAI_API_KEY" "OpenAI API key"
  prompt_key_if_missing "CLOUDFLARE_ACCOUNT_ID" "Cloudflare Account ID"
  prompt_key_if_missing "CLOUDFLARE_API_TOKEN" "Cloudflare API Token"
  prompt_key_if_missing "STACKBILT_GATEWAY_KEY" "Gateway local auth key (default: local-dev-key)"
  prompt_key_if_missing "STACKBILT_GATEWAY_PORT" "Gateway port (default: 8787)"

  echo "[init] running doctor..."
  doctor
}

launch_claude() {
  require_cmd claude
  start_gateway
  echo "[gateway] routing Claude Code through ${GATEWAY_URL}"
  exec env \
    ANTHROPIC_BASE_URL="${GATEWAY_URL}" \
    ANTHROPIC_API_KEY="${GATEWAY_KEY}" \
    claude "$@"
}

launch_codex() {
  require_cmd codex
  start_gateway
  echo "[gateway] routing Codex-compatible OpenAI API traffic through ${GATEWAY_URL}/v1"
  exec env \
    OPENAI_BASE_URL="${GATEWAY_URL}/v1" \
    OPENAI_API_KEY="${GATEWAY_KEY}" \
    STACKBILT_GATEWAY_KEY="${GATEWAY_KEY}" \
    codex "$@"
}

usage() {
  cat <<'EOF'
Usage:
  ./gateway.sh up
  ./gateway.sh down
  ./gateway.sh restart
  ./gateway.sh status
  ./gateway.sh logs
  ./gateway.sh doctor
  ./gateway.sh init
  ./gateway.sh claude [claude args...]
  ./gateway.sh codex [codex args...]

Environment overrides:
  STACKBILT_GATEWAY_PORT (default: 8787)
  STACKBILT_GATEWAY_KEY  (default: local-dev-key)
  GATEWAY_PID_FILE       (default: /tmp/llm-gateway.pid)
  GATEWAY_LOG_FILE       (default: /tmp/llm-gateway.log)
EOF
}

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  usage
  exit 1
fi
shift || true

case "$cmd" in
  up) start_gateway ;;
  down) stop_gateway ;;
  restart) stop_gateway || true; start_gateway ;;
  status) status_gateway ;;
  logs) show_logs ;;
  doctor) doctor ;;
  init) init ;;
  claude) launch_claude "$@" ;;
  codex) launch_codex "$@" ;;
  *)
    usage
    exit 1
    ;;
esac
