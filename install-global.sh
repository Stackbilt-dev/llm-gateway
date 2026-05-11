#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.local/bin"
TARGET="${TARGET_DIR}/stackbilt-gw"

mkdir -p "$TARGET_DIR"
ln -sf "$SCRIPT_DIR/gateway.sh" "$TARGET"
chmod +x "$SCRIPT_DIR/gateway.sh"

echo "Installed: $TARGET -> $SCRIPT_DIR/gateway.sh"
if [[ ":${PATH}:" != *":${TARGET_DIR}:"* ]]; then
  echo ""
  echo "Add this to your shell profile (~/.bashrc or ~/.zshrc):"
  echo "export PATH=\"${TARGET_DIR}:\$PATH\""
fi

echo ""
echo "Next steps:"
echo "  stackbilt-gw init"
echo "  stackbilt-gw claude   # from any repo"
echo "  stackbilt-gw codex    # from any repo"
