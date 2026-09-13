/*
 * Token accounting for the gateway.
 *
 * Two independent ledgers, both written to one JSONL:
 *
 *   request  — per /v1/messages request: bytes before/after the projection, the
 *              delta, and an estimated token saving (bytes / 4). This measures
 *              the REDUCTION the gateway applied, not the API's bill.
 *   usage    — the REAL usage Anthropic returned, scanned out of the response
 *              stream. The response is still relayed verbatim; the scanner only
 *              reads a copy. Streaming SSE carries input_tokens + cache_* in
 *              `message_start` and output_tokens in `message_delta`; non-stream
 *              JSON carries one `usage` object.
 *
 * Observational only: never throws, never touches the relay.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CHARS_PER_TOKEN = 4;

/** @param {number} bytes */
export function estimateTokens(bytes) {
	return Math.ceil(bytes / CHARS_PER_TOKEN);
}

/** @param {string} path */
export function createAccounting(path) {
	try { mkdirSync(dirname(path), { recursive: true }); } catch {}
	return function record(entry) {
		try {
			appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
		} catch {
			/* accounting must never break the request path */
		}
	};
}

/**
 * Brace-aware extraction of every `"usage": { ... }` object in a text.
 * A regex fails here because usage can nest, e.g.
 * `"usage":{"input_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":2}}`.
 * @param {string} text
 * @returns {Record<string,any>[]}
 */
function extractUsageObjects(text) {
	const objects = [];
	const key = '"usage"';
	let index = 0;
	while ((index = text.indexOf(key, index)) >= 0) {
		let cursor = index + key.length;
		while (cursor < text.length && text[cursor] !== "{") cursor += 1;
		if (cursor >= text.length) break;
		let depth = 0;
		let inString = false;
		let escaped = false;
		let end = -1;
		for (let i = cursor; i < text.length; i += 1) {
			const ch = text[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth += 1;
			else if (ch === "}") {
				depth -= 1;
				if (depth === 0) { end = i + 1; break; }
			}
		}
		if (end < 0) break;
		try { objects.push(JSON.parse(text.slice(cursor, end))); } catch { /* skip malformed */ }
		index = end;
	}
	return objects;
}

/** @param {Record<string,any>} usage @param {Record<string,number>} out */
function applyUsage(usage, out) {
	if (typeof usage.input_tokens === "number") out.input_tokens = Math.max(out.input_tokens ?? 0, usage.input_tokens);
	if (typeof usage.cache_read_input_tokens === "number") out.cache_read_input_tokens = Math.max(out.cache_read_input_tokens ?? 0, usage.cache_read_input_tokens);
	let cacheWrite = usage.cache_creation_input_tokens;
	if (typeof cacheWrite !== "number" && usage.cache_creation && typeof usage.cache_creation === "object") {
		cacheWrite = (usage.cache_creation.ephemeral_5m_input_tokens || 0) + (usage.cache_creation.ephemeral_1h_input_tokens || 0);
	}
	if (typeof cacheWrite === "number") out.cache_creation_input_tokens = Math.max(out.cache_creation_input_tokens ?? 0, cacheWrite);
	// output_tokens grows across a stream; the last value wins.
	if (typeof usage.output_tokens === "number") out.output_tokens = usage.output_tokens;
}

/** @param {string} text @param {Record<string,number>} out */
function mergeUsage(text, out) {
	for (const usage of extractUsageObjects(text)) applyUsage(usage, out);
}

/**
 * Scans a response stream copy for usage without materializing the whole body:
 * keeps a bounded head (message_start) and a rolling tail (message_delta / JSON).
 * @param {number} headLimit @param {number} tailLimit
 */
export function createResponseUsageScanner(headLimit = 128 * 1024, tailLimit = 32 * 1024) {
	let head = "";
	let headChars = 0;
	let tail = "";
	let emitted = false;
	function collect() {
		/** @type {Record<string,number>} */
		const out = {};
		mergeUsage(head, out);
		mergeUsage(tail, out);
		return Object.keys(out).length > 0 ? out : undefined;
	}
	return {
		/**
		 * Feed a response chunk. Returns usage as soon as the response signals
		 * completion (`message_stop` for streaming, `stop_reason` for JSON), so we
		 * do not depend on the connection closing (keep-alive may never close it).
		 * @param {Buffer} chunk
		 * @returns {Record<string,number> | undefined}
		 */
		feed(chunk) {
			const text = chunk.toString("utf8");
			if (headChars < headLimit) {
				head += text;
				headChars += text.length;
				if (head.length > headLimit) head = head.slice(0, headLimit);
			}
			tail = (tail + text).slice(-tailLimit);
			if (!emitted && (text.includes('"message_stop"') || text.includes('"stop_reason"'))) {
				const usage = collect();
				if (usage) {
					emitted = true;
					return usage;
				}
			}
			return undefined;
		},
		/** Fallback for a connection that closes before a completion marker. */
		finish() {
			if (emitted) return undefined;
			const usage = collect();
			if (usage) emitted = true;
			return usage;
		},
	};
}

/** Cheap, non-parsing metadata extraction from a request body. @param {string} bodyText */
export function requestMeta(bodyText) {
	return {
		model: bodyText.match(/"model"\s*:\s*"([^"]+)"/)?.[1],
		cacheMarkers: (bodyText.match(/"cache_control"/g) || []).length,
	};
}
