# SoL-ClaudeCode

**English** | [简体中文](./README.md)

Context-efficiency mechanisms from [NVIDIA SoL-Pi](https://github.com/NVlabs/SoL-Pi)
(the Pi coding-agent extension), reimplemented for **Claude Code** as a two-part
system:

- **Wire gateway** — a local MITM proxy for `api.anthropic.com` that rewrites the
  outgoing `/v1/messages` payload while preserving the first-party host identity.
- **Companion plugin** — a Claude Code plugin (`obs_recall` MCP tool + hooks) that
  supplies the client-side half the gateway cannot provide.

The reason for two parts: only the plugin can *actually execute* a tool, and only
the gateway can *rewrite the context sent to the model*. SoL-Pi's mechanisms that
touch the projected context live in the gateway; the ones that execute in the
harness live in the plugin.

## Architecture

```
claude ──TLS──► gateway (MITM, keeps host = api.anthropic.com)
                     │  parse HTTP/1.1
                     │  project messages:
                     │    · Evidence-Preserving Reducer  (verified receipt)
                     │    · ObservationPack              (large tool_result → handle)
                     ▼
              corp proxy ──► real api.anthropic.com        (responses relayed verbatim)

plugin ──► mcp/server.mjs  → obs_recall(id, offset, query)  reads the archive the gateway wrote
       └─► hooks           → SessionStart health check, optional PostToolUse fusion
```

Every mutation is **fail-open**: any error, timeout, or unverifiable result forwards
the original bytes. A gateway bug cannot corrupt a session.

## Layout

```
shared/                     contract imported by BOTH sides (single source of truth)
  observation-pack.mjs        ObservationPack core + archive + recall + search
  evidence-reducer.mjs        Reducer core: instructions, validation, receipt
gateway/
  gateway.mjs                 the MITM gateway
  lib/http1.mjs               HTTP/1.1 request parser/serializer
  lib/project.mjs             the projection pipeline (reducer → ObservationPack)
  lib/reducer.mjs             pluggable reducer providers
  lib/trajectory.mjs          metadata-only trajectory log
  gen-ca.sh, run-gateway.sh, mitm-probe.mjs
plugin/                     self-contained Claude Code plugin
  .claude-plugin/plugin.json
  .mcp.json                   starts mcp/server.mjs
  mcp/server.mjs              obs_recall (stdio JSON-RPC, zero deps)
  vendor/                     vendored copy of shared/ (script: npm run vendor)
  hooks/, commands/
tests/                      node:test suites (npm test)
```

## Install (one-click)

```bash
./install.sh        # vendors the shared contract, makes the CA, registers the plugin
./bin/solclaudecode         # minimal launch: starts the gateway if down, runs claude through it
./bin/solclaudecode -p "…"  # one-shot
```

`install.sh` registers a local marketplace and installs `sol-claudecode@sol-claudecode`. It is
reversible:

```bash
claude plugin uninstall sol-claudecode@sol-claudecode
claude plugin marketplace remove sol-claudecode
```

Add `bin/` to `PATH` for a bare `solclaudecode`. `bin/solclaudecode` brings the gateway up on
`127.0.0.1:${SOLCLAUDECODE_GATEWAY_PORT:-8789}` and exports `NODE_EXTRA_CA_CERTS` +
`HTTPS_PROXY`, so no manual env juggling.

## Manual run

```bash
# 1. one-time: local CA + leaf cert for api.anthropic.com
./gateway/gen-ca.sh

# 2. start the gateway
./gateway/run-gateway.sh 8789

# 3. point Claude Code at it (plugin installed, or --plugin-dir "$PWD/plugin")
NODE_EXTRA_CA_CERTS="$PWD/gateway/ca/ca.pem" \
HTTPS_PROXY=http://127.0.0.1:8789 \
HTTP_PROXY=http://127.0.0.1:8789 \
NO_PROXY=localhost,127.0.0.1 \
claude
```

Claude Code only applies the **global** `settings.json` `env` block to
`process.env`, so the proxy must be a real environment variable. For https,
`HTTPS_PROXY` is consulted and beats the `HTTP_PROXY` a corporate `settings.json`
injects.

## Mechanisms

| SoL-Pi mechanism | Where | Status |
|---|---|---|
| **ObservationPack** | gateway (projection) + plugin (`obs_recall`) | ✅ implemented, end-to-end verified |
| **Evidence-Preserving Reducer** | gateway (projection) | ✅ implemented, opt-in provider |
| **Trajectory Inspector** | gateway | ✅ metadata-only JSONL (`gateway/logs/trajectory.jsonl`) |
| **Action Fusion** | plugin (PostToolUse hook) | ✅ opt-in (`SOLCLAUDECODE_FUSION_COMMAND`) |
| **Online Context Compact** | — | ⛔ not faithfully portable (see below) |

**Why Online Context Compact is not ported.** SoL-Pi calls Pi's native
`ExtensionContext.compact()` at plan boundaries, then triggers a continuation
turn. Claude Code performs compaction **client-side**; the gateway never sees a
compaction entry, and there is no wire signal to hook. A gateway-side rewrite of
conversation history would risk breaking `tool_use`/`tool_result` pairing, so it
is deliberately not implemented. Context reduction is instead delivered by
ObservationPack (old large results collapse to handles).

## Token accounting

Every request and response is metered to `gateway/logs/tokens.jsonl`:

- **request** — bytes before/after projection, the delta, and an estimated token
  saving (bytes / 4). This is the reduction the gateway applied.
- **usage** — the **real** counts Anthropic returned (`input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`), scanned out of the
  response stream while it is relayed untouched.

Report (prices are yours to supply — nothing is hardcoded):

```bash
SOLCLAUDECODE_PRICE_IN=15 SOLCLAUDECODE_PRICE_OUT=75 node scripts/token-report.mjs
```

To read usage, the gateway asks upstream for `Accept-Encoding: identity` (the
`/v1/messages` reply is otherwise gzip'd SSE, opaque to the scanner). Set
`SOLCLAUDECODE_KEEP_ENCODING=1` to preserve compression and give up usage accounting.

Because most of a warm session is served as **cache reads** (billed at ~10% of
input), the money saved is smaller than the raw token reduction — measure it, do
not assume it. The report prints two cost views:

- **As billed** — honors the cache read/write prices (the real bill).
- **Cache-free** — a hypothetical where every input token costs the full input
  price, so the caching discount does not mask the reduction. This is not a bill;
  it shows the same absolute saving against a larger denominator, which is useful
  for judging the packing on a cache-cold workload.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `SOLCLAUDECODE_HOME` | `~/.sol-claudecode` | archive root (shared by gateway and plugin) |
| `SOLCLAUDECODE_FULL_SENDS` | `2` | requests a large result is sent in full before packing |
| `SOLCLAUDECODE_DRY_RUN` | unset | log mutations without applying them |
| `SOLCLAUDECODE_KEEP_ENCODING` | unset | `1` keeps upstream gzip/br (disables usage accounting) |
| `SOLCLAUDECODE_REDUCER_PROVIDER` | `none` | `none` \| `command` \| `openai` \| `anthropic` |
| `SOLCLAUDECODE_REDUCER_COMMAND` | — | for `command`: reads reducer input on stdin, prints receipt JSON |
| `SOLCLAUDECODE_REDUCER_BASE_URL` / `_API_KEY` / `_MODEL` | — | for `openai` |
| `SOLCLAUDECODE_REDUCER_MAX_OUTPUT_TOKENS` / `_TIMEOUT_MS` | 2048 / 90000 | reducer limits |
| `SOLCLAUDECODE_FUSION_COMMAND` | unset | Action Fusion follow-up command after Edit/Write |

The reducer is **off by default**. The `anthropic` provider reuses the intercepted
request's `Authorization` header to make a nested model call — it spends the same
subscription the user is already spending, so enable it deliberately.

## Archive contract

Observation ids embed the content hash, so the archive is content-addressed and the
gateway (writer) and plugin (reader) need no session key to meet at the same object.

```
$SOLCLAUDECODE_HOME/observation-pack/objects/<obs_id>.txt        # 0600
$SOLCLAUDECODE_HOME/evidence-preserving-reducer/objects/<hh>/<sha>.txt
```

Observation id: `obs_` + `sha256(toolName \0 toolCallId \0 contentHash)[:24]`.

## Security

- The gateway **redacts** `Authorization` / `x-api-key` / `Cookie` before logging.
- The plugin never logs prompts or tool output; the trajectory is metadata only.
- The CA is generated locally, passed via `NODE_EXTRA_CA_CERTS`, and is never added
  to the system trust store. Delete `gateway/ca/` when done.
- Archived tool results may contain sensitive data — the archive lives under the
  user's home with `0600` files; keep it out of version control.

## Concurrency, forks, subagents, many Claudes

The gateway is a single local process that many Claude Code instances share. How
each situation behaves:

| Situation | Behavior |
|---|---|
| **Many `claude` at once** | One gateway serves them all. Counters are keyed by `X-Claude-Code-Session-Id`, so sessions never interfere. `bin/solclaudecode` reuses a running gateway instead of starting a second one. |
| **Concurrent `solclaudecode` launches** | Only one gateway can bind the port; the loser gets `EADDRINUSE` and exits cleanly, while the launcher waits for the port and proceeds. |
| **Fork / branch** | A fork has a new session id, so its grace period starts fresh. Placeholders inherited from the parent stay recallable because the archive is **content-addressed and global**, not session-scoped. |
| **Subagents / agent teams** | Requests carry their own session id; if a subagent shares its parent's id and runs in parallel, projection for that session is **serialized** so the send counters cannot race. |
| **Missing session header** | Falls back to a per-connection key, so unrelated requests never share one counter bucket. |
| **Memory over a long run** | Session/observation counters are LRU-bounded (`SOLCLAUDECODE_MAX_SESSIONS`, `SOLCLAUDECODE_MAX_OBSERVATIONS`). |
| **Archive growth** | `npm run gc` (or `node scripts/solclaudecode-gc.mjs [days]`) deletes archived objects older than 14 days. |

| `SOLCLAUDECODE_MAX_SESSIONS` | 2000 | LRU cap on tracked sessions |
| `SOLCLAUDECODE_MAX_OBSERVATIONS` | 5000 | LRU cap on observations per session |
| `SOLCLAUDECODE_GC_DAYS` | 14 | age for `npm run gc` |

## Tests

```bash
npm test          # node --test tests/*.test.mjs  (11 tests)
npm run vendor    # re-sync shared/ into plugin/vendor/
```
