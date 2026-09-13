/*
 * SoL-ClaudeCode — ObservationPack core (shared contract).
 *
 * A faithful port of NVIDIA SoL-Pi's ObservationPack mechanism, adapted from
 * Pi's in-harness `context` projection to the Anthropic Messages wire payload.
 *
 * SoL-Pi (src/sol-pi/extensions/observation-pack/*) rewrites only the messages
 * *projected to the provider*: a large tool result is sent in full for its first
 * FULL_SENDS requests, then replaced by a short stable placeholder. Original
 * bytes are archived by observation id and pulled back exactly with `obs_recall`.
 *
 * Differences from upstream, and why:
 *   - Extraction reads the wire `tool_result` content block, not Pi's
 *     ToolResultMessage. Both content shapes (string | text[] ) are supported.
 *   - The archive is a single content-addressed root (SOLCLAUDECODE_HOME), not a
 *     per-Pi-session directory. The observation id already embeds the content
 *     hash, so gateway (writer) and plugin/MCP (reader) need no session key to
 *     meet at the same object.
 *
 * Invariant: every function here is fail-open-friendly. Callers must be able to
 * drop a mutation and forward the original request untouched.
 *
 * @typedef {{ id: string, contentHash: string, toolName: string, text: string, bytes: number, lines: number, tokens: number }} Observation
 * @typedef {{ text: string, bytes: number, lines: number, nextOffset: number, eof: boolean }} RecallChunk
 * @typedef {{ byteOffset: number, byteEnd: number, line: number, contextStart: number, contextEnd: number, context: string }} SearchMatch
 * @typedef {{ matches: SearchMatch[], nextOffset: number, eof: boolean, scannedBytes: number }} SearchResult
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Only tool results larger than this participate. */
export const THRESHOLD_BYTES = 10 * 1024;
/** Provider requests that still carry the full payload before the placeholder takes over. */
export const FULL_SENDS = process.env.SOLCLAUDECODE_FULL_SENDS ? Number(process.env.SOLCLAUDECODE_FULL_SENDS) : 2;
/** Placeholder excerpt budget, split evenly between head and tail, whole lines only. */
export const PLACEHOLDER_EXCERPT_BYTES = 1024;

export const SEARCH_MAX_MATCHES = 20;
export const RECALL_MAX_BYTES = 16 * 1024;
export const RECALL_MAX_LINES = 400;

const CHARS_PER_TOKEN = 4;
export const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;
const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Receipts from the evidence-preserving reducer are already a reduction of a
 * long log. Packing them again would replace verified evidence with an excerpt.
 */
export const EVIDENCE_REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";

/**
 * obs_recall's own output starts with this header. Packing a recall response
 * would replace the bytes the model just asked for with another placeholder,
 * so recall output is never eligible (belt-and-braces; the projector also
 * excludes the recall tool by name).
 */
export const RECALL_HEADER_PREFIX = "[obs_recall ";

const SEARCH_READ_BYTES = 4096;
const SEARCH_CONTEXT_BYTES = 256;

/** @param {string | Buffer} value */
export function hashText(value) {
	return createHash("sha256").update(value).digest("hex");
}

/** @param {string} text */
export function estimateTokens(text) {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** @param {string} text */
export function countLines(text) {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (const character of text) if (character === "\n") lines += 1;
	return lines;
}

/** @param {Buffer} buffer */
function countBufferLines(buffer) {
	if (buffer.length === 0) return 0;
	let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
	for (const byte of buffer) if (byte === 0x0a) lines += 1;
	return lines;
}

/** @param {unknown} id */
export function isObservationId(id) {
	return typeof id === "string" && OBSERVATION_ID_PATTERN.test(id);
}

/** Archive root shared by the gateway (writer) and the plugin MCP server (reader). @param {Record<string,string|undefined>} [env] */
export function archiveRoot(env = process.env) {
	return env.SOLCLAUDECODE_HOME || join(homedir(), ".sol-claudecode");
}

/** @param {string} root @param {string} id */
export function objectPath(root, id) {
	return join(root, "observation-pack", "objects", `${id}.txt`);
}

/** Extract the text of a wire tool_result block, or null when it is not a plain, non-error text result. @param {unknown} block */
export function textFromToolResult(block) {
	if (typeof block !== "object" || block === null) return null;
	if (block.type !== "tool_result") return null;
	if (block.is_error === true) return null;
	const content = block.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content) && content.length > 0) {
		const parts = [];
		for (const part of content) {
			if (typeof part !== "object" || part === null) return null;
			if (part.type !== "text" || typeof part.text !== "string") return null;
			parts.push(part.text);
		}
		return parts.join("\n");
	}
	return null;
}

/** @param {string} text */
function containsReducerReceipt(text) {
	return text.split("\n").some((line) => line === EVIDENCE_REDUCER_RECEIPT_PREFIX);
}

/** @param {string} toolName @param {string} toolUseId @param {string} contentHash */
export function makeObservationId(toolName, toolUseId, contentHash) {
	return `obs_${hashText(`${toolName}\0${toolUseId}\0${contentHash}`).slice(0, 24)}`;
}

/**
 * Build an Observation for an eligible wire tool_result block, or undefined when
 * it is ineligible (too small, error, non-text, not plain, or already a receipt).
 * @param {unknown} block @param {string} toolName @returns {Observation | undefined}
 */
export function buildObservation(block, toolName) {
	const text = textFromToolResult(block);
	if (text === null) return undefined;
	if (containsReducerReceipt(text)) return undefined;
	if (text.startsWith(RECALL_HEADER_PREFIX)) return undefined;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= THRESHOLD_BYTES) return undefined;
	const contentHash = hashText(text);
	const id = makeObservationId(toolName, String(block.tool_use_id ?? ""), contentHash);
	return { id, contentHash, toolName, text, bytes, lines: countLines(text), tokens: estimateTokens(text) };
}

/**
 * Write the payload to its content-addressed path, refusing symlinks and
 * verifying an existing object byte for byte before reusing it.
 * @param {string} root @param {Observation} observation
 */
export async function ensureStored(root, observation) {
	const filePath = objectPath(root, observation.id);
	const directoryPath = dirname(filePath);
	await mkdir(directoryPath, { recursive: true, mode: 0o700 });
	const directoryStats = await lstat(directoryPath);
	if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
		throw new Error(`Observation directory is not a regular directory for ${observation.id}`);
	}

	let handle;
	try {
		handle = await open(filePath, CREATE_OBJECT_FLAGS, 0o600);
		await handle.writeFile(observation.text, { encoding: "utf8" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		const existingHandle = await open(filePath, READ_OBJECT_FLAGS);
		try {
			const existing = await existingHandle.stat();
			if (!existing.isFile()) throw new Error(`Content-addressed observation is not a regular file for ${observation.id}`);
			if (existing.size !== observation.bytes) throw new Error(`Content-addressed observation size mismatch for ${observation.id}`);
			const existingContent = await existingHandle.readFile();
			if (hashText(existingContent) !== observation.contentHash) {
				throw new Error(`Content-addressed observation hash mismatch for ${observation.id}`);
			}
		} finally {
			await existingHandle.close();
		}
	} finally {
		if (handle) await handle.close();
	}
}

/** @param {string} text @param {number} budgetBytes @param {boolean} fromEnd */
function completeLineExcerpt(text, budgetBytes, fromEnd) {
	const lines = text.split(/(?<=\n)/);
	const selected = [];
	let selectedBytes = 0;
	let index = fromEnd ? lines.length - 1 : 0;
	while (index >= 0 && index < lines.length) {
		const line = lines[index];
		if (line === undefined) break;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (selectedBytes + lineBytes > budgetBytes) break;
		if (fromEnd) selected.unshift(line);
		else selected.push(line);
		selectedBytes += lineBytes;
		index += fromEnd ? -1 : 1;
	}
	return selected.join("");
}

/** @param {Observation} observation */
export function placeholderFor(observation) {
	const headBudget = Math.floor(PLACEHOLDER_EXCERPT_BYTES / 2);
	const tailBudget = PLACEHOLDER_EXCERPT_BYTES - headBudget;
	const head = completeLineExcerpt(observation.text, headBudget, false);
	const tail = completeLineExcerpt(observation.text, tailBudget, true);
	return [
		`[large tool result replaced after its first ${FULL_SENDS} provider requests]`,
		`id: ${observation.id}`,
		`tool: ${observation.toolName}`,
		`original_bytes: ${observation.bytes}`,
		`original_lines: ${observation.lines}`,
		`estimated_tokens: ${observation.tokens}`,
		`retrieve: call obs_recall with {"id":"${observation.id}","offset":0}; add query for literal search; continue with next_offset`,
		`[first complete lines, up to ${headBudget} bytes]`,
		head,
		`[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
		tail,
		`[${observation.bytes} original bytes omitted]`,
	].join("\n");
}

/** @param {Buffer} buffer @param {number} limit */
function trimUtf8End(buffer, limit) {
	let end = limit;
	while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return end;
}

/** @param {Buffer} buffer @param {number} start */
function trimUtf8Start(buffer, start) {
	let result = start;
	while (result < buffer.length && ((buffer[result] ?? 0) & 0xc0) === 0x80) result += 1;
	return result;
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
	if (signal?.aborted) throw new Error("Observation search aborted");
}

/** @param {import("node:fs/promises").FileHandle} handle @param {Buffer} buffer @param {number} position @param {AbortSignal | undefined} signal */
async function readSnapshot(handle, buffer, position, signal) {
	let total = 0;
	while (total < buffer.length) {
		throwIfAborted(signal);
		const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total);
		if (bytesRead === 0) throw new Error("Stored observation shrank during search");
		total += bytesRead;
	}
}

/** @param {import("node:fs/promises").FileHandle} handle @param {number} offset @param {AbortSignal | undefined} signal */
async function countPrefixLines(handle, offset, signal) {
	let position = 0;
	let lines = 1;
	while (position < offset) {
		const length = Math.min(SEARCH_READ_BYTES, offset - position);
		const buffer = Buffer.alloc(length);
		await readSnapshot(handle, buffer, position, signal);
		for (const byte of buffer) if (byte === 0x0a) lines += 1;
		position += length;
	}
	return { lines, bytes: position };
}

/** @param {import("node:fs/promises").FileHandle} handle @param {number} size @param {number} byteOffset @param {number} byteEnd @param {AbortSignal | undefined} signal */
async function contextFor(handle, size, byteOffset, byteEnd, signal) {
	const windowStart = Math.max(0, byteOffset - SEARCH_CONTEXT_BYTES);
	const windowEnd = Math.min(size, byteEnd + SEARCH_CONTEXT_BYTES);
	const buffer = Buffer.alloc(Math.min(size, windowEnd + 3) - windowStart);
	await readSnapshot(handle, buffer, windowStart, signal);
	const start = trimUtf8Start(buffer, 0);
	const end = trimUtf8End(buffer, windowEnd - windowStart);
	return {
		contextStart: windowStart + start,
		contextEnd: windowStart + end,
		context: buffer.subarray(start, end).toString("utf8"),
	};
}

/**
 * Search an archived observation as literal UTF-8 bytes (case-sensitive, overlapping matches).
 * @param {string} path @param {Buffer} query @param {number} offset @param {number} maxResultBytes @param {AbortSignal | undefined} signal
 * @returns {Promise<SearchResult>}
 */
export async function searchObservation(path, query, offset, maxResultBytes, signal) {
	const handle = await open(path, READ_OBJECT_FLAGS);
	try {
		const fileStats = await handle.stat();
		if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
		if (offset > fileStats.size) throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);
		const prefix = await countPrefixLines(handle, offset, signal);
		let position = offset;
		let line = prefix.lines;
		let carry = Buffer.alloc(0);
		let scannedBytes = prefix.bytes;
		const matches = [];
		while (position < fileStats.size) {
			throwIfAborted(signal);
			const length = Math.min(SEARCH_READ_BYTES, fileStats.size - position);
			const chunk = Buffer.alloc(length);
			await readSnapshot(handle, chunk, position, signal);
			scannedBytes += length;
			const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
			const base = position - carry.length;
			let combinedBaseLine = line;
			for (const byte of carry) if (byte === 0x0a) combinedBaseLine -= 1;
			let index = 0;
			for (;;) {
				throwIfAborted(signal);
				const found = combined.indexOf(query, index);
				if (found < 0) break;
				const byteOffset = base + found;
				if (byteOffset >= offset && byteOffset + query.length <= position + length) {
					const beforeMatch = combined.subarray(0, found);
					let matchLine = combinedBaseLine;
					for (const byte of beforeMatch) if (byte === 0x0a) matchLine += 1;
					const byteEnd = byteOffset + query.length;
					const context = await contextFor(handle, fileStats.size, byteOffset, byteEnd, signal);
					const match = { byteOffset, byteEnd, line: matchLine, ...context };
					const serialized = Buffer.byteLength(JSON.stringify(match), "utf8") + 1;
					let used = 0;
					for (const entry of matches) used += Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
					if (matches.length >= SEARCH_MAX_MATCHES || used + serialized > maxResultBytes) {
						return { matches, nextOffset: byteOffset, eof: false, scannedBytes };
					}
					matches.push(match);
					if (matches.length >= SEARCH_MAX_MATCHES) return { matches, nextOffset: byteOffset + 1, eof: false, scannedBytes };
				}
				index = found + 1;
			}
			for (const byte of chunk) if (byte === 0x0a) line += 1;
			carry = combined.subarray(Math.max(0, combined.length - (query.length - 1)));
			position += length;
		}
		return { matches, nextOffset: fileStats.size, eof: true, scannedBytes };
	} finally {
		await handle.close();
	}
}

/**
 * Read one paged chunk starting at byte offset.
 * @param {string} path @param {number} offset @param {{maxBytes:number,maxLines:number}} limits
 * @returns {Promise<RecallChunk>}
 */
export async function readRecallChunk(path, offset, limits) {
	const handle = await open(path, READ_OBJECT_FLAGS);
	try {
		const fileStats = await handle.stat();
		if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
		if (offset > fileStats.size) throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);
		const available = Math.max(0, fileStats.size - offset);
		const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 4));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		let end = Math.min(bytesRead, limits.maxBytes);
		let newlineCount = 0;
		for (let index = 0; index < end; index += 1) {
			if (buffer[index] !== 0x0a) continue;
			newlineCount += 1;
			if (newlineCount === limits.maxLines) {
				end = index + 1;
				break;
			}
		}
		end = trimUtf8End(buffer, end);
		const chunk = buffer.subarray(0, end);
		const nextOffset = offset + chunk.length;
		return { text: chunk.toString("utf8"), bytes: chunk.length, lines: countBufferLines(chunk), nextOffset, eof: nextOffset >= fileStats.size };
	} finally {
		await handle.close();
	}
}
