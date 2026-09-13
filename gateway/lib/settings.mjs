// Resolve the upstream proxy Claude Code itself would use, by reading the same
// settings.json layers Claude Code reads — global, then project, then local —
// and merging their `env` blocks (later layers win). This is what lets the MITM
// "auto-follow" whatever proxy you set in settings.json: change it there, and
// the gateway picks it up on next start with no code edit.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readJson(path) {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		process.stderr.write(`[settings] skip ${path}: ${error.message}\n`);
		return undefined;
	}
}

/**
 * @param {string} [cwd] project root to look for project-scoped settings
 * @returns {{ env: Record<string,string>, sources: string[] }}
 */
export function loadClaudeEnv(cwd = process.cwd()) {
	const layers = [
		join(homedir(), ".claude", "settings.json"), // user global
		join(cwd, ".claude", "settings.json"), // project
		join(cwd, ".claude", "settings.local.json"), // project local (git-ignored)
	];
	const env = {};
	const sources = [];
	for (const path of layers) {
		const parsed = readJson(path);
		if (parsed?.env && typeof parsed.env === "object") {
			Object.assign(env, parsed.env);
			sources.push(path);
		}
	}
	return { env, sources };
}

/**
 * The upstream proxy for an HTTPS request to api.anthropic.com, following the
 * same precedence Node/undici use: HTTPS_PROXY beats HTTP_PROXY; lowercase is a
 * fallback for each. Returns undefined when no proxy is configured (direct).
 * @returns {{ url: string|undefined, noProxy: string, source: 'HTTPS_PROXY'|'HTTP_PROXY'|'none' }}
 */
export function resolveUpstreamProxy(env) {
	const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
	const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
	const noProxy = env.NO_PROXY ?? env.no_proxy ?? "";
	if (httpsProxy) return { url: httpsProxy, noProxy, source: "HTTPS_PROXY" };
	if (httpProxy) return { url: httpProxy, noProxy, source: "HTTP_PROXY" };
	return { url: undefined, noProxy, source: "none" };
}

/** Parse a proxy URL into { host, port, auth } where auth is a Basic header value or undefined. */
export function parseProxyUrl(url) {
	const u = new URL(url);
	const auth = u.username
		? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`
		: undefined;
	return { host: u.hostname, port: Number(u.port || 8080), auth };
}
