#!/usr/bin/env bash
# Deterministic A/B benchmark: gateway projection OFF vs ON, same task, same
# clean workspace each trial. Reports real token usage pulled from the gateway's
# accounting (both arms are metered the same way, so the comparison is fair).
#
#   ./scripts/bench-ab.sh [trials]
#
# Prereqs: gateway/ca exists; a workspace with 3 large files at $BENCH_WS/src.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WS="${BENCH_WS:-/tmp/solbench}"
N="${1:-3}"
PORT_OFF=8791
PORT_ON=8792
TASK="${BENCH_TASK:-Do each step as its own tool call, in order: (1) Read src/alpha.txt. (2) Read src/beta.txt. (3) Read src/gamma.txt. (4) Bash: wc -l src/alpha.txt. (5) Bash: wc -l src/beta.txt. (6) Bash: wc -l src/gamma.txt. (7) Give a 2-sentence summary.}"

sum_tokens() {
	node -e '
		const fs=require("fs");
		const p=process.argv[1];
		let rows=[];
		try { rows=fs.readFileSync(p,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(r=>r&&r.kind==="usage"); } catch {}
		const s=k=>rows.reduce((a,r)=>a+(r[k]||0),0);
		const input=s("input_tokens"),output=s("output_tokens"),cr=s("cache_read_input_tokens"),cw=s("cache_creation_input_tokens");
		console.log(JSON.stringify({total:input+output+cr+cw,input,output,cache_read:cr,cache_write:cw,requests:rows.length}));
	' "$1"
}

run_arm() {
	local arm="$1" port="$2" disable="$3"
	pkill -f 'gateway/gateway.mjs' 2>/dev/null; sleep 0.6
	( cd "$ROOT" && SOLCLAUDECODE_HOME="$WS/home-$arm" SOLCLAUDECODE_DISABLE_PROJECTION="$disable" nohup node gateway/gateway.mjs "$port" >/tmp/gw-$arm.log 2>&1 & )
	sleep 1.3
	echo "### ARM $arm (port $port, projection $([ "$disable" = 1 ] && echo OFF || echo ON))"
	for i in $(seq 1 "$N"); do
		: > "$ROOT/gateway/logs/tokens.jsonl"
		( cd "$WS" && NODE_EXTRA_CA_CERTS="$ROOT/gateway/ca/ca.pem" HTTPS_PROXY="http://127.0.0.1:$port" HTTP_PROXY="http://127.0.0.1:$port" NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 \
			claude --dangerously-skip-permissions -p "$TASK" >/dev/null 2>&1 )
		printf '  trial %s: ' "$i"; sum_tokens "$ROOT/gateway/logs/tokens.jsonl"
	done
	pkill -f 'gateway/gateway.mjs' 2>/dev/null; sleep 0.4
}

[ -d "$WS/src" ] || { echo "missing workspace $WS/src (create 3 large files)"; exit 1; }
run_arm OFF "$PORT_OFF" 1
run_arm ON "$PORT_ON" 0
echo "done"
