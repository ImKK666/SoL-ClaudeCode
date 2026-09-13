---
description: Show SoL-Pi gateway and ObservationPack archive status
---

Report the current SoL-Pi for Claude Code status, concisely:

1. Gateway: run `lsof -nP -iTCP:${SOLPI_GATEWAY_PORT:-8789} -sTCP:LISTEN` and say whether the ObservationPack gateway is up.
2. Archive: run `ls -1 "${SOLPI_HOME:-$HOME/.sol-pi}/observation-pack/objects" 2>/dev/null | wc -l` and report how many archived observations exist, plus their total size with `du -sh`.
3. If anything looks wrong, say what to do: start the gateway with `node gateway/gateway.mjs` from the Sol-ClaudeCode repo.

Do not modify anything.
