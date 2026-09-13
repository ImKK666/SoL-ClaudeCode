#!/usr/bin/env bash
# Start the SoL-Pi gateway for Claude Code.
#
# Prereqs: gateway/ca/{leaf.key,leaf.pem} must exist (run gateway/gen-ca.sh once).
# Then point Claude Code at it (see README), e.g.:
#   NODE_EXTRA_CA_CERTS=gateway/ca/ca.pem \
#   HTTPS_PROXY=http://127.0.0.1:8789 HTTPS_PROXY=... claude --plugin-dir plugin
#
# Env:
#   SOLPI_HOME            archive root (default ~/.sol-pi)
#   SOLPI_REDUCER_PROVIDER none|command|openai|anthropic (default none)
#   SOLPI_DRY_RUN=1       log mutations without applying them
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8789}"

if [ ! -f "$HERE/ca/leaf.pem" ] || [ ! -f "$HERE/ca/leaf.key" ]; then
  echo "[gateway] leaf cert missing — running gen-ca.sh"
  "$HERE/gen-ca.sh"
fi

echo "[gateway] archive root: ${SOLPI_HOME:-$HOME/.sol-pi}"
echo "[gateway] reducer provider: ${SOLPI_REDUCER_PROVIDER:-none}"
exec node "$HERE/gateway.mjs" "$PORT"
