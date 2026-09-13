// SoL-ClaudeCode gateway — MITM probe / foundation (read-only, verbatim forwarding)
//
// Purpose: answer one binary question — does the Claude Code (native Bun) client
// accept a locally-trusted CA for api.anthropic.com, or is there certificate
// pinning? It does NOT rewrite anything: it terminates the client's TLS with a
// local leaf cert (proving trust / no-pinning if the handshake completes), taps
// the first decrypted request bytes for a one-line log, then pipes the byte
// stream to the real api.anthropic.com through whatever upstream proxy
// settings.json defines.
//
// Verdicts:
//   CLIENT_TLS_OK    handshake with our cert succeeded -> no pinning, CA honored
//   CLIENT_TLS_FAIL  client rejected our cert          -> pinning or CA not loaded
//   UPSTREAM_*       our side was fine; the corp proxy / real API leg failed
//
// Hardening vs. the first draft:
//   - every raw socket gets an 'error' handler (an ECONNRESET no longer kills us)
//   - ALPN is advertised to the client and *mirrored* to the upstream, so the
//     two ends always speak the same protocol (h2 stays h2, http/1.1 stays 1.1)
//   - non-target hosts are passed through as a transparent TCP tunnel instead of
//     being mis-routed to api.anthropic.com
//   - client bytes are buffered until the upstream is ready (no loss window)
//
// Run:  node gateway/mitm-probe.mjs [listenPort]

import { connect as netConnect } from "node:net";
import { createServer } from "node:http";
import { connect as tlsConnect, TLSSocket } from "node:tls";
import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadClaudeEnv, parseProxyUrl, resolveUpstreamProxy } from "./lib/settings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.argv[2] || 8788);
const TARGET_HOST = "api.anthropic.com";
const TARGET_PORT = 443;
const LOG = join(HERE, "logs", "probe.log");
// Optional: when SOLCLAUDECODE_CAPTURE is set to a path, dump each connection's decrypted
// client->upstream bytes (credential headers redacted) there for offline analysis.
const CAPTURE = process.env.SOLCLAUDECODE_CAPTURE || "";

const key = readFileSync(join(HERE, "ca", "leaf.key"));
const cert = readFileSync(join(HERE, "ca", "leaf.pem"));

const { env, sources } = loadClaudeEnv();
const upstream = resolveUpstreamProxy(env);

function log(line) {
	const stamped = `${new Date().toISOString()} ${line}`;
	process.stdout.write(`${stamped}\n`);
	try { appendFileSync(LOG, `${stamped}\n`); } catch {}
}

function maskAuth(url) {
	try { const u = new URL(url); if (u.password) u.password = "***"; return u.toString(); } catch { return url; }
}

// Strip credential-bearing header VALUES before anything is logged. The tap only
// ever describes a request; it must never write a Bearer/x-api-key to disk.
function redactHeaders(s) {
	return s.replace(/((?:authorization|proxy-authorization|x-api-key|api-key|cookie)\s*:\s*)[^\r\n]*/gi, "$1***");
}

function tag(code, err) {
	const e = err instanceof Error ? err : new Error(String(err));
	e.probeCode = code;
	return e;
}

// Open a raw TCP stream to host:port, tunneling through the settings.json proxy
// with CONNECT when one is configured, else direct.
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
			const lines = [
				`CONNECT ${host}:${port} HTTP/1.1`,
				`Host: ${host}:${port}`,
			];
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

// Raw socket errors must NEVER crash the process (the first draft died here).
server.on("connection", (socket) => {
	socket.on("error", (e) => log(`[client-raw] ${e.code || e.message}`));
});

server.on("clientError", (err, socket) => {
	log(`[client-error] ${err.code || err.message}`);
	try { socket.destroy(); } catch {}
});

// A non-CONNECT request only happens on a plain-HTTP proxy call.
server.on("request", (req, res) => {
	log(`[http] non-CONNECT ${req.method} ${req.url}`);
	res.writeHead(502, { "content-type": "text/plain" });
	res.end("probe: use CONNECT");
});

server.on("connect", (req, clientSocket, head) => {
	const [host, portRaw] = String(req.url).split(":");
	const port = Number(portRaw || 443);
	log(`[connect] client requested ${req.url}`);

	// Non-target hosts: transparent TCP tunnel, no TLS termination.
	if (host !== TARGET_HOST) {
		dialUpstream(host, port).then((up) => {
			up.on("error", (e) => { log(`[passthrough→${host}] ${e.code || e.message}`); clientSocket.destroy(); });
			clientSocket.on("close", () => up.destroy());
			up.on("close", () => clientSocket.destroy());
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head?.length) up.write(head);
			clientSocket.pipe(up);
			up.pipe(clientSocket);
			log(`[passthrough] tunnel open → ${host}:${port}`);
		}).catch((e) => {
			log(`[passthrough→${host}] ${e.probeCode || "FAIL"} ${e.message}`);
			try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {}
		});
		return;
	}

	// MITM path: terminate the client's TLS with our local leaf cert.
	clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
	if (head?.length) clientSocket.unshift(head);

	const clientTls = new TLSSocket(clientSocket, {
		isServer: true,
		key,
		cert,
		ALPNProtocols: ["h2", "http/1.1"],
	});

	let handshakeVerdict = false;
	let firstTap = false;
	let upstreamTls = null;
	let upstreamReady = false;
	const pending = [];
	let captureStarted = false;

	clientTls.on("error", (e) => {
		if (!handshakeVerdict) {
			log(`CLIENT_TLS_FAIL  ${e.code || e.message}  (pinning, or NODE_EXTRA_CA_CERTS not honored)`);
		} else {
			log(`[client] post-handshake error: ${e.code || e.message}`);
		}
		try { clientSocket.destroy(); } catch {}
		if (upstreamTls) upstreamTls.destroy();
	});

	clientTls.on("data", (chunk) => {
		if (CAPTURE) {
			try {
				if (!captureStarted) {
					captureStarted = true;
					appendFileSync(CAPTURE, `\n===== conn ${new Date().toISOString()} =====\n`);
				}
				appendFileSync(CAPTURE, redactHeaders(chunk.toString("utf8")));
			} catch {}
		}
		if (!firstTap) {
			firstTap = true;
			const raw = chunk.toString("latin1", 0, Math.min(chunk.length, 512));
			const headStr = redactHeaders(raw).slice(0, 240).replace(/\r?\n/g, " ⏎ ");
			log(`[decrypted→] first client bytes: ${headStr}`);
		}
		if (upstreamReady && upstreamTls) upstreamTls.write(chunk);
		else pending.push(chunk);
	});

	clientTls.on("secure", () => {
		handshakeVerdict = true;
		log(`CLIENT_TLS_OK  (client accepted local CA — no pinning; alpn=${clientTls.alpnProtocol || "none"})`);
	});

	clientTls.once("secure", async () => {
		let upRaw;
		try {
			upRaw = await dialUpstream(TARGET_HOST, TARGET_PORT);
		} catch (e) {
			log(`${e.probeCode || "UPSTREAM_FAIL"}  ${e.message}`);
			clientTls.destroy();
			return;
		}
		const alpn = clientTls.alpnProtocol; // mirror the client's choice upstream
		const upOpts = { socket: upRaw, servername: TARGET_HOST };
		if (alpn) upOpts.ALPNProtocols = [alpn];
		upstreamTls = tlsConnect(upOpts, () => {
			upstreamReady = true;
			log(`[upstream] TLS to real api.anthropic.com established (alpn=${upstreamTls.alpnProtocol || "none"}) — flushing ${pending.length} chunk(s)`);
			for (const c of pending.splice(0)) upstreamTls.write(c);
		});
		upstreamTls.on("error", (e) => { log(`UPSTREAM_TLS_FAIL  ${e.code || e.message}`); clientTls.destroy(); });
		upstreamTls.on("data", (chunk) => { try { clientTls.write(chunk); } catch {} });
		upstreamTls.on("close", () => clientTls.destroy());
		clientTls.on("close", () => upstreamTls.destroy());
	});
});

server.on("error", (e) => log(`[server] ${e.message}`));
server.listen(LISTEN_PORT, "127.0.0.1", () => log("[boot] ready — waiting for a request"));
