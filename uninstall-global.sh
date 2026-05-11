#!/usr/bin/env bash
set -euo pipefail

TARGET="${HOME}/.local/bin/stackbilt-gw"

if [[ -L "$TARGET" || -f "$TARGET" ]]; then
  rm -f "$TARGET"
  echo "Removed: $TARGET"
else
  echo "Not installed: $TARGET"
fi
