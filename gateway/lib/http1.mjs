/*
 * Minimal HTTP/1.1 request parser/serializer for the wire gateway.
 *
 * We only ever see the client->upstream direction as HTTP/1.1 (verified: Claude
 * Code posts /v1/messages as "POST /v1/messages?beta=true HTTP/1.1" with a
 * Content-Length body and no Content-Encoding). Responses are relayed verbatim
 * and never parsed here.
 *
 * Scope: parse complete requests out of a byte stream, preserve every header
 * byte-for-byte, allow the body to be replaced with a Content-Length rewrite.
 * Anything we cannot frame (chunked, oversized) is surfaced so the caller can
 * fail open and fall back to a raw pipe.
 */

const CRLFCRLF = Buffer.from("\r\n\r\n", "latin1");
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** @typedef {{ name: string, value: string }} Header */
/** @typedef {{ method: string, target: string, version: string, headers: Header[], body: Buffer | null, chunked: boolean, raw: Buffer }} ParsedRequest */

/** @param {ParsedRequest} req @param {string} name */
export function headerValue(req, name) {
	const lower = name.toLowerCase();
	for (const h of req.headers) if (h.name.toLowerCase() === lower) return h.value;
	return undefined;
}

/** Rebuild a request, replacing the body and rewriting Content-Length. @param {ParsedRequest} req @param {Buffer} body */
export function serializeRequest(req, body) {
	const lines = [`${req.method} ${req.target} ${req.version}`];
	let sawLength = false;
	for (const h of req.headers) {
		if (h.name.toLowerCase() === "content-length") {
			sawLength = true;
			lines.push(`Content-Length: ${body.length}`);
			continue;
		}
		lines.push(`${h.name}: ${h.value}`);
	}
	if (!sawLength) lines.push(`Content-Length: ${body.length}`);
	return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), body]);
}

export class Http1RequestParser {
	constructor() {
		this.buffer = Buffer.alloc(0);
		this.broken = false;
	}

	/** True once the stream is beyond what this parser can frame (caller must fall back to a raw pipe). */
	get isBroken() {
		return this.broken;
	}

	/** Feed bytes; returns every complete request now available. @param {Buffer} chunk @returns {ParsedRequest[]} */
	push(chunk) {
		if (this.broken) return [];
		this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
		/** @type {ParsedRequest[]} */
		const requests = [];
		for (;;) {
			const req = this.takeOne();
			if (req === null) break;
			requests.push(req);
		}
		if (!this.broken && this.buffer.length > MAX_BUFFER_BYTES) this.broken = true;
		return requests;
	}

	/** Return and clear any bytes not yet framed, so a fallback raw pipe loses nothing. */
	takeRemaining() {
		const remaining = this.buffer;
		this.buffer = Buffer.alloc(0);
		return remaining;
	}

	/** @returns {ParsedRequest | null} */
	takeOne() {
		const headerEnd = this.buffer.indexOf(CRLFCRLF);
		if (headerEnd < 0) return null;

		const headText = this.buffer.subarray(0, headerEnd).toString("latin1");
		const headLines = headText.split("\r\n");
		const requestLine = headLines[0] ?? "";
		const parts = requestLine.split(" ");
		const method = parts[0] ?? "";
		const target = parts[1] ?? "";
		const version = parts[2] ?? "HTTP/1.1";

		/** @type {Header[]} */
		const headers = [];
		let contentLength = 0;
		let hasLength = false;
		let chunked = false;
		for (const line of headLines.slice(1)) {
			if (line.length === 0) continue;
			const colon = line.indexOf(":");
			if (colon < 0) continue;
			const name = line.slice(0, colon).trim();
			const value = line.slice(colon + 1).trim();
			headers.push({ name, value });
			const lower = name.toLowerCase();
			if (lower === "content-length") {
				contentLength = Number(value);
				hasLength = true;
			} else if (lower === "transfer-encoding" && /\bchunked\b/i.test(value)) {
				chunked = true;
			}
		}

		const bodyStart = headerEnd + 4;

		if (chunked) {
			const terminator = this.buffer.indexOf(Buffer.from("0\r\n\r\n", "latin1"), bodyStart);
			if (terminator < 0) return null;
			const end = terminator + 5;
			const raw = Buffer.from(this.buffer.subarray(0, end));
			this.buffer = this.buffer.subarray(end);
			return { method, target, version, headers, body: null, chunked: true, raw };
		}

		if (!hasLength) {
			const raw = Buffer.from(this.buffer.subarray(0, bodyStart));
			this.buffer = this.buffer.subarray(bodyStart);
			return { method, target, version, headers, body: Buffer.alloc(0), chunked: false, raw };
		}

		if (!Number.isFinite(contentLength) || contentLength < 0) {
			this.broken = true;
			return null;
		}
		if (this.buffer.length < bodyStart + contentLength) return null;

		const end = bodyStart + contentLength;
		const body = Buffer.from(this.buffer.subarray(bodyStart, end));
		const raw = Buffer.from(this.buffer.subarray(0, end));
		this.buffer = this.buffer.subarray(end);
		return { method, target, version, headers, body, chunked: false, raw };
	}
}
