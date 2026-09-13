// SoL-ClaudeCode gateway for Claude Code — wire layer.
//
// Terminates Claude Code's TLS to api.anthropic.com (keeping the host identity
// so first-party features stay on), then applies SoL-Pi's ObservationPack
// projection to POST /v1/messages: large tool results are replaced with a stable
// placeholder after their first FULL_SENDS provider requests, with the original
// archived under the shared content-addressed root for `obs_recall`.
//
// Everything else is forwarded verbatim. Every failure path falls back to the
// original bytes, so a bug here can never corrupt a paid session.
//
// Run:  node gateway/gateway.mjs [listenPort]
// Env:  SOLCLAUDECODE_HOME (archive root)   SOLCLAUDECODE_DRY_RUN=1 (log, never rewrite)

import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect, TLSSocket } from "node:tls";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadClaudeEnv, parseProxyUrl, resolveUpstreamProxy } from "./lib/settings.mjs";
import { headerValue, Http1RequestParser, serializeRequest } from "./lib/http1.mjs";
import { createProjector } from "./lib/project.mjs";
import { createTrajectory } from "./lib/trajectory.mjs";
import { createAccounting, createResponseUsageScanner, estimateTokens, requestMeta } from "./lib/accounting.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.argv[2] || 8789);
const TARGET_HOST = "api.anthropic.com";
const TARGET_PORT = 443;
const LOG = join(HERE, "logs", "gateway.log");
const LEDGER = join(HERE, "logs", "gateway.jsonl");
const TRAJECTORY = join(HERE, "logs", "trajectory.jsonl");
const TOKENS = join(HERE, "logs", "tokens.jsonl");
const DRY_RUN = process.env.SOLCLAUDECODE_DRY_RUN === "1";
/** Set SOLCLAUDECODE_KEEP_ENCODING=1 to stop forcing identity (keeps gzip/br, loses usage accounting). */
const KEEP_ENCODING = process.env.SOLCLAUDECODE_KEEP_ENCODING === "1";

const key = readFileSync(join(HERE, "ca", "leaf.key"));
const cert = readFileSync(join(HERE, "ca", "leaf.pem"));

const { env, sources } = loadClaudeEnv();
const upstream = resolveUpstreamProxy(env);
const projector = createProjector();
const trajectory = createTrajectory(TRAJECTORY);
const accounting = createAccounting(TOKENS);
let requestCounter = 0;
let connectionCounter = 0;

function log(line) {
	const stamped = `${new Date().toISOString()} ${line}`;
	process.stdout.write(`${stamped}\n`);
	try { appendFileSync(LOG, `${stamped}\n`); } catch {}
}

function ledger(entry) {
	try { appendFileSync(LEDGER, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`); } catch {}
}

function maskAuth(url) {
	try { const u = new URL(url); if (u.password) u.password = "***"; return u.toString(); } catch { return url; }
}

function tag(code, err) {
	const e = err instanceof Error ? err : new Error(String(err));
	e.probeCode = code;
	return e;
}

/**
 * Normalize Accept-Encoding to identity on the upstream request.
 *
 * /v1/messages responses are gzip'd SSE (verified: content-encoding=gzip,
 * text/event-stream). We relay them verbatim, so a gzip body is opaque to the
 * usage scanner. Asking for identity makes the response plaintext — the scanner
 * can read `usage`, and SSE is no longer buffered for compression.
 */
function withIdentity(headers) {
	let found = false;
	const out = headers.map((h) => {
		if (h.name.toLowerCase() === "accept-encoding") {
			found = true;
			return { name: h.name, value: "identity" };
		}
		return h;
	});
	if (!found) out.push({ name: "Accept-Encoding", value: "identity" });
	return out;
}

function dialUpstream(host, port) {
	return new Promise((resolve, reject) => {
		if (!upstream.url) {
			const s = netConnect(port, host);
			s.once("connect", () => resolve(s));
			s.once("error", (e) => reject(tag("UPSTREAM_CONNECT_FAIL", e)));
			return;
		}
		const { host: phost, port: pport, auth } = parseProxyUrl(upstream.url);
		const s = netConnect(pport, phost);
		s.once("error", (e) => reject(tag("UPSTREAM_PROXY_CONNECT_FAIL", e)));
		s.once("connect", () => {
			const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
			if (auth) lines.push(`Proxy-Authorization: ${auth}`);
			s.write(`${lines.join("\r\n")}\r\n\r\n`);
			let buf = Buffer.alloc(0);
			const onData = (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				const headerEnd = buf.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;
				s.removeListener("data", onData);
				const statusLine = buf.slice(0, buf.indexOf("\r\n")).toString();
				if (!/ 200 /.test(statusLine)) {
					reject(tag("UPSTREAM_PROXY_REFUSED", new Error(statusLine)));
					s.destroy();
					return;
				}
				const leftover = buf.slice(headerEnd + 4);
				if (leftover.length) s.unshift(leftover);
				resolve(s);
			};
			s.on("data", onData);
		});
	});
}

const server = createServer();

server.on("connection", (socket) => {
	socket.on("error", (e) => log(`[client-raw] ${e.code || e.message}`));
});

server.on("clientError", (err, socket) => {
	log(`[client-error] ${err.code || err.message}`);
	try { socket.destroy(); } catch {}
});

server.on("request", (req, res) => {
	log(`[http] non-CONNECT ${req.method} ${req.url}`);
	res.writeHead(502, { "content-type": "text/plain" });
	res.end("gateway: use CONNECT");
});

server.on("connect", (req, clientSocket, head) => {
	const [host, portRaw] = String(req.url).split(":");
	const port = Number(portRaw || 443);
	const connectionId = ++connectionCounter;
	log(`[connect] ${req.url}`);

	if (host !== TARGET_HOST) {
		dialUpstream(host, port).then((up) => {
			up.on("error", (e) => { log(`[passthrough→${host}] ${e.code || e.message}`); clientSocket.destroy(); });
			clientSocket.on("close", () => up.destroy());
			up.on("close", () => clientSocket.destroy());
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head?.length) up.write(head);
			clientSocket.pipe(up);
			up.pipe(clientSocket);
		}).catch((e) => {
			log(`[passthrough→${host}] ${e.probeCode || "FAIL"} ${e.message}`);
			try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {}
		});
		return;
	}

	clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
	if (head?.length) clientSocket.unshift(head);

	const clientTls = new TLSSocket(clientSocket, { isServer: true, key, cert, ALPNProtocols: ["h2", "http/1.1"] });

	let handshakeVerdict = false;
	let upstreamTls = null;
	let upstreamReady = false;
	let rawMode = false;
	const pending = [];
	let chain = Promise.resolve();
	const parser = new Http1RequestParser();
	let currentRequestId = null;
	let currentSession = null;
	let usageScanner = createResponseUsageScanner();
	let usageRecorded = false;

	const writeUp = (buf) => {
		if (!upstreamTls || upstreamTls.destroyed) return;
		try { upstreamTls.write(buf); } catch (e) { log(`[upstream-write] ${e.message}`); }
	};

	async function forwardRequest(request) {
		// A new request begins a new response cycle on this (sequential) keep-alive
		// connection: reset the usage scanner and bind the next response to this id.
		usageScanner = createResponseUsageScanner();
		usageRecorded = false;
		currentRequestId = ++requestCounter;
		currentSession = headerValue(request, "X-Claude-Code-Session-Id") ?? "-";

		// Only real generations. `/v1/messages/count_tokens` shares the prefix but
		// must not consume ObservationPack send counts or be rewritten.
		const isMessages = request.target === "/v1/messages" || request.target.startsWith("/v1/messages?");
		const projectable = request.method === "POST" && isMessages && !request.chunked && request.body;
		const headers = request.body !== null && !KEEP_ENCODING ? withIdentity(request.headers) : request.headers;
		const forward = (body) => writeUp(request.body !== null ? serializeRequest({ ...request, headers }, body) : request.raw);

		if (!projectable) { forward(request.body ?? Buffer.alloc(0)); return; }

		const session = currentSession;
		let result;
		try {
			result = await projector(request.headers, request.body, `conn-${connectionId}`);
		} catch (error) {
			log(`[project] fail-open: ${error instanceof Error ? error.message : String(error)}`);
			forward(request.body);
			return;
		}
		trajectory({ kind: "request", session, path: request.target, bodyBytes: request.body.length, packed: result.packed, reduced: result.reduced, changed: result.changed });
		const meta = requestMeta(request.body.toString("utf8"));
		accounting({
			kind: "request",
			requestId: currentRequestId,
			session,
			path: request.target,
			model: meta.model,
			bodyBytesBefore: request.body.length,
			bodyBytesAfter: result.body.length,
			savedBytes: result.changed ? request.body.length - result.body.length : 0,
			savedTokens: result.changed ? estimateTokens(request.body.length - result.body.length) : 0,
			packed: result.packed,
			reduced: result.reduced,
			cacheMarkers: meta.cacheMarkers,
		});
		if (!result.changed) {
			forward(request.body);
			return;
		}
		if (DRY_RUN) {
			log(`[dry-run] session=${session} would pack ${result.packed} / reduce ${result.reduced} (${request.body.length}B body)`);
			ledger({ mode: "dry-run", session, packed: result.packed, reduced: result.reduced, notes: result.notes });
			forward(request.body);
			return;
		}
		forward(result.body);
		log(`[pack] session=${session} packed=${result.packed} reduced=${result.reduced} body ${request.body.length}B -> ${result.body.length}B`);
		ledger({ mode: "pack", session, packed: result.packed, reduced: result.reduced, notes: result.notes });
	}

	async function processChunk(chunk) {
		if (rawMode) { writeUp(chunk); return; }
		let requests;
		try {
			requests = parser.push(chunk);
		} catch (error) {
			log(`[parse] fail-open: ${error instanceof Error ? error.message : String(error)}`);
			rawMode = true;
			writeUp(parser.takeRemaining());
			return;
		}
		for (const request of requests) await forwardRequest(request);
		if (parser.isBroken) {
			rawMode = true;
			writeUp(parser.takeRemaining());
			log("[parse] fallback to raw pipe");
		}
	}

	const enqueue = (chunk) => {
		chain = chain.then(() => processChunk(chunk)).catch((e) => log(`[chain] ${e.message}`));
	};

	clientTls.on("error", (e) => {
		if (!handshakeVerdict) log(`CLIENT_TLS_FAIL  ${e.code || e.message}`);
		else log(`[client] post-handshake error: ${e.code || e.message}`);
		try { clientSocket.destroy(); } catch {}
		if (upstreamTls) upstreamTls.destroy();
	});

	clientTls.on("secure", () => {
		handshakeVerdict = true;
		log(`CLIENT_TLS_OK (alpn=${clientTls.alpnProtocol || "none"})`);
	});

	clientTls.on("data", (chunk) => {
		if (upstreamReady) enqueue(chunk);
		else pending.push(Buffer.from(chunk));
	});

	clientTls.once("secure", async () => {
		let upRaw;
		try {
			upRaw = await dialUpstream(TARGET_HOST, TARGET_PORT);
		} catch (e) {
			log(`${e.probeCode || "UPSTREAM_FAIL"} ${e.message}`);
			clientTls.destroy();
			return;
		}
		const alpn = clientTls.alpnProtocol;
		const upOpts = { socket: upRaw, servername: TARGET_HOST };
		if (alpn) upOpts.ALPNProtocols = [alpn];
		upstreamTls = tlsConnect(upOpts, () => {
			upstreamReady = true;
			log(`[upstream] established (alpn=${upstreamTls.alpnProtocol || "none"})`);
			for (const c of pending.splice(0)) enqueue(c);
		});
		upstreamTls.on("error", (e) => { log(`UPSTREAM_TLS_FAIL ${e.code || e.message}`); clientTls.destroy(); });
		let responseBytes = 0;
		let respHeadLogged = false;
		const respDump = process.env.SOLCLAUDECODE_RESP_DUMP || "";
		const recordUsage = (usage) => {
			if (!usage || usageRecorded) return;
			usageRecorded = true;
			accounting({ kind: "usage", requestId: currentRequestId, session: currentSession, responseBytes, ...usage });
		};
		upstreamTls.on("data", (chunk) => {
			responseBytes += chunk.length;
			if (!respHeadLogged) {
				respHeadLogged = true;
				const head = chunk.toString("latin1", 0, Math.min(chunk.length, 2048));
				const status = head.split("\r\n")[0];
				const enc = /content-encoding:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "identity";
				const ct = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "?";
				log(`[resp] ${status} | content-encoding=${enc} | content-type=${ct}`);
			}
			if (respDump) {
				try { appendFileSync(respDump, `\n===== resp ${new Date().toISOString()} =====\n${chunk.toString("latin1", 0, Math.min(chunk.length, 4096))}\n`); } catch {}
			}
			recordUsage(usageScanner.feed(chunk));
			try { clientTls.write(chunk); } catch {}
		});
		upstreamTls.on("close", () => clientTls.destroy());
		clientTls.on("close", () => {
			upstreamTls.destroy();
			trajectory({ kind: "connection", responseBytes });
			recordUsage(usageScanner.finish());
		});
	});
});

server.on("error", (e) => {
	log(`[server] ${e.message}`);
	// A concurrent `solclaudecode` won the race for the port; this instance has no job.
	if (e.code === "EADDRINUSE") process.exit(1);
});
server.listen(LISTEN_PORT, "127.0.0.1", () => {
	log(`[boot] gateway on 127.0.0.1:${LISTEN_PORT}${DRY_RUN ? " (DRY RUN)" : ""}`);
	log(`[boot] settings: ${sources.join(", ") || "(none)"}`);
	log(`[boot] upstream: ${upstream.url ? `${maskAuth(upstream.url)} (${upstream.source})` : "DIRECT"}`);
	log(`[boot] archive root: ${process.env.SOLCLAUDECODE_HOME || "~/.sol-claudecode"}`);
});
