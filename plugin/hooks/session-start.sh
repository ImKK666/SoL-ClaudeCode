#!/usr/bin/env bash
# SessionStart hook: report whether the ObservationPack gateway is up, so the
# model knows whether placeholders can be recalled. One short line, fail-safe.
set -euo pipefail
PORT="${SOLPI_GATEWAY_PORT:-8789}"
ROOT="${SOLPI_HOME:-$HOME/.sol-pi}"

listening="no"
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then listening="yes"; fi
elif command -v nc >/dev/null 2>&1; then
  if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then listening="yes"; fi
fi

if [ "$listening" = "yes" ]; then
  echo "SoL-Pi gateway: up on 127.0.0.1:$PORT (ObservationPack active; archive $ROOT)."
else
  echo "SoL-Pi gateway: DOWN (expected 127.0.0.1:$PORT). Large tool results are not being packed; obs_recall will find nothing."
fi
exit 0
