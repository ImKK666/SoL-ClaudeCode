#!/usr/bin/env bash
# SoL-ClaudeCode — one-shot install.
#
#   ./install.sh
#
# Does three things:
#   1. vendors the shared contract into the plugin (so it is self-contained)
#   2. generates the local api.anthropic.com CA if missing
#   3. registers the plugin with Claude Code via a local marketplace
#
# Reversible: claude plugin uninstall sol-claudecode@sol-claudecode
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "[1/3] vendoring shared contract into plugin/vendor"
node "$ROOT/scripts/vendor-shared.mjs"

echo "[2/3] ensuring local CA"
if [ ! -f "$ROOT/gateway/ca/leaf.pem" ] || [ ! -f "$ROOT/gateway/ca/leaf.key" ]; then
  "$ROOT/gateway/gen-ca.sh" >/dev/null
  echo "      generated gateway/ca/ (delete it to revoke)"
else
  echo "      gateway/ca/ already present"
fi

echo "[3/3] registering the plugin with Claude Code"
if claude plugin marketplace add "$ROOT" 2>/dev/null; then
  echo "      marketplace added: sol-claudecode"
else
  echo "      marketplace already present; updating"
  claude plugin marketplace update sol-claudecode >/dev/null 2>&1 || true
fi
if claude plugin install "sol-claudecode@sol-claudecode" 2>/dev/null; then
  echo "      plugin installed: sol-claudecode@sol-claudecode"
else
  echo "      plugin already installed"
fi

cat <<EOF

Installed. Launch Claude Code through the gateway with:

  $ROOT/bin/solclaudecode                 # interactive session
  $ROOT/bin/solclaudecode -p "..."        # one-shot

Optional: add $ROOT/bin to your PATH for a bare \`solclaudecode\`.

  export PATH="$ROOT/bin:\$PATH"

Uninstall:

  claude plugin uninstall sol-claudecode@sol-claudecode
  claude plugin marketplace remove sol-claudecode
EOF
