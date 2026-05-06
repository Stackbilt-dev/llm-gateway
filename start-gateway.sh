#!/usr/bin/env bash
# Start the StackBilt LLM Gateway locally.
# Usage:  ./start-gateway.sh
#         ./start-gateway.sh --port 9000

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
PKG_DIR="$SCRIPT_DIR/packages/llm-gateway"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

# Load .env (skip comments and blank lines)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Gateway auth key defaults to "local-dev-key" if not set
export STACKBILT_GATEWAY_KEY="${STACKBILT_GATEWAY_KEY:-local-dev-key}"

exec npx --prefix "$PKG_DIR" tsx "$PKG_DIR/src/cli.ts" start "$@"
