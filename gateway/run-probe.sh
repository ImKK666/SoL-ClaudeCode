#!/usr/bin/env bash
# Drive one real Claude Code request through the local MITM probe.
#
# The probe must already be running (in another terminal):
#     tmux new-session -d -s solpi-probe \
#       "node gateway/mitm-probe.mjs 8788 2>&1 | tee gateway/logs/probe.stdout.log"
#
# Launch contract (verified 2026-09-13):
#   - The proxy env MUST be a REAL process env var. Claude Code only applies the
#     *global* settings.json env block to process.env; env passed via --settings is
#     not reliably used to pick the proxy.
#   - For https, `HTTPS_PROXY` is consulted and beats the `HTTP_PROXY` that the
#     corp global settings inject into process.env.
#   - NODE_EXTRA_CA_CERTS must also be a real env var, set before runtime TLS init.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8788}"
CA="$HERE/ca/ca.pem"
PROXY="http://127.0.0.1:$PORT"

echo "[run] routing claude through probe: $PROXY (upstream read from ~/.claude/settings.json)"
echo "[run] NODE_EXTRA_CA_CERTS=$CA"
echo "[run] launching one non-interactive request..."

NODE_EXTRA_CA_CERTS="$CA" \
HTTPS_PROXY="$PROXY" \
HTTP_PROXY="$PROXY" \
NO_PROXY="localhost,127.0.0.1" no_proxy="localhost,127.0.0.1" \
claude -p "Reply with the single word: pong"

echo
echo "[run] done — check the probe terminal for CLIENT_TLS_OK / CLIENT_TLS_FAIL"
