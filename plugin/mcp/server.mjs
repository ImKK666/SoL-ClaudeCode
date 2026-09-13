/*
 * SoL-Pi MCP server — the harness-side half of ObservationPack.
 *
 * Exposes one tool, `obs_recall`, which reads the content-addressed archive the
 * wire gateway writes. It is a deliberately minimal stdio JSON-RPC server (new
 * line delimited), so it needs no SDK at runtime.
 *
 * Shared contract: ../../shared/observation-pack.mjs (same module the gateway
 * imports). The archive root is SOLPI_HOME or ~/.sol-pi.
 */

import { createInterface } from "node:readline";
import {
	archiveRoot,
	isObservationId,
	objectPath,
	readRecallChunk,
	searchObservation,
	RECALL_MAX_BYTES,
	RECALL_MAX_LINES,
	SEARCH_MAX_MATCHES,
} from "../vendor/observation-pack.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const MAX_QUERY_BYTES = 256;

const TOOL = {
	name: "obs_recall",
	description:
		"Read back a large tool result that was replaced by a Sol-Pi observation placeholder. " +
		"Pass the placeholder's `id` and page with `offset` (default 0), or pass `query` for a " +
		"case-sensitive literal UTF-8 byte search (max 256 bytes). Results are UTF-8 safe and " +
		"bounded to 16 KiB / 400 lines; continue until eof is true.",
	inputSchema: {
		type: "object",
		properties: {
			id: { type: "string", description: "Observation id from the placeholder, e.g. obs_<24 hex>" },
			offset: { type: "integer", minimum: 0, description: "Byte offset to start reading from (default 0)" },
			query: { type: "string", description: "Optional literal, case-sensitive search string (max 256 UTF-8 bytes)" },
		},
		required: ["id"],
	},
};

function textResult(text) {
	return { content: [{ type: "text", text }] };
}

function errorResult(text) {
	return { content: [{ type: "text", text }], isError: true };
}

async function recall(args) {
	const id = args?.id;
	if (!isObservationId(id)) return errorResult(`obs_recall error: invalid observation id ${JSON.stringify(id)}`);
	const path = objectPath(archiveRoot(), id);
	const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;

	try {
		if (args.query !== undefined) {
			const query = Buffer.from(String(args.query), "utf8");
			if (query.length === 0) return errorResult("obs_recall error: query must be non-empty");
			if (query.length > MAX_QUERY_BYTES) return errorResult(`obs_recall error: query exceeds ${MAX_QUERY_BYTES} UTF-8 bytes`);
			const result = await searchObservation(path, query, offset, RECALL_MAX_BYTES - 512, undefined);
			const lines = [
				`[obs_recall search id=${id} offset=${offset} next_offset=${result.nextOffset} eof=${result.eof}]`,
				`[matches=${result.matches.length}/${SEARCH_MAX_MATCHES} scanned_bytes=${result.scannedBytes}; contexts are JSON strings]`,
				...result.matches.map((m) =>
					JSON.stringify({
						byte_offset: m.byteOffset,
						byte_end: m.byteEnd,
						line: m.line,
						context_start: m.contextStart,
						context_end: m.contextEnd,
						context: m.context,
					}),
				),
			];
			return textResult(lines.join("\n"));
		}

		const chunk = await readRecallChunk(path, offset, { maxBytes: RECALL_MAX_BYTES - 512, maxLines: RECALL_MAX_LINES - 2 });
		const header = [
			`[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
			`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
		].join("\n");
		return textResult(`${header}\n${chunk.text}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("ENOENT")) return errorResult(`obs_recall error: no archived observation ${id}`);
		return errorResult(`obs_recall error: ${message}`);
	}
}

async function handle(message) {
	const { id, method, params } = message;
	if (method === "initialize") {
		return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "sol-pi", version: "0.1.0" } } };
	}
	if (method === "notifications/initialized" || method === "initialized") return null;
	if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
	if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [TOOL] } };
	if (method === "tools/call") {
		const name = params?.name;
		if (name !== TOOL.name) return { jsonrpc: "2.0", id, result: errorResult(`unknown tool ${name}`) };
		const result = await recall(params?.arguments ?? {});
		return { jsonrpc: "2.0", id, result };
	}
	if (id === undefined) return null; // notification we do not handle
	return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (trimmed.length === 0) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		return;
	}
	handle(message)
		.then((response) => {
			if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
		})
		.catch((error) => {
			if (message?.id !== undefined) {
				process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error) } })}\n`);
			}
		});
});
