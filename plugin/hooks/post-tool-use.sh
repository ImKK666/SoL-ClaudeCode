#!/usr/bin/env bash
# Action Fusion (plugin side).
#
# After an Edit/Write, optionally run a configured follow-up command and hand its
# output back to the model in the same turn — the Claude Code analog of SoL-Pi's
# fused `then_run`. Disabled unless SOLCLAUDECODE_FUSION_COMMAND is set, so it is inert
# by default. Fail-safe: a failure never blocks or errors the tool.
set -uo pipefail

CMD="${SOLCLAUDECODE_FUSION_COMMAND:-}"
if [ -z "$CMD" ]; then
  exit 0
fi

exec 0<&0 # keep stdin for future use; the command does not need it

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true
OUT="$(eval "$CMD" 2>&1 | tail -c 4000)" || true

# Emit additionalContext so the model sees the follow-up result.
node -e 'const body=process.argv[1]||"";process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"[then_run] "+process.env.SOLCLAUDECODE_FUSION_COMMAND+"\n"+body}}))' "$OUT" 2>/dev/null || true
exit 0
