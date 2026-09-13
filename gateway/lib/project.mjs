/*
 * Request projection: the ObservationPack mutation, applied to a parsed
 * /v1/messages request body.
 *
 * This is where the gateway does exactly what SoL-Pi's `context` event does —
 * replace large tool results with a stable placeholder after their first
 * FULL_SENDS provider requests, archiving the original under the shared
 * content-addressed root.
 *
 * Fail-open contract: `projectMessagesRequest` returns the ORIGINAL body when
 * anything is off (unparseable JSON, unexpected shape, archive error). It never
 * throws and never returns a body that would break the request.
 */

import { archiveRoot, buildObservation, ensureStored, FULL_SENDS, placeholderFor } from "../../shared/observation-pack.mjs";
import { createReducer, loadReducerConfig } from "./reducer.mjs";

/** @typedef {{ body: Buffer, changed: boolean, packed: number, reduced: number, notes: string[] }} ProjectionResult */

/** @param {{name:string,value:string}[]} headers @param {any} body @param {string} [fallback] */
function sessionKey(headers, body, fallback) {
	for (const h of headers) if (h.name.toLowerCase() === "x-claude-code-session-id") return h.value;
	const metadata = body?.metadata;
	if (typeof metadata === "object" && metadata !== null) {
		const userId = metadata.user_id;
		if (typeof userId === "string") {
			try {
				const parsed = JSON.parse(userId);
				if (typeof parsed.session_id === "string") return parsed.session_id;
			} catch {
				/* not JSON: fall through */
			}
		}
	}
	// No session identity: isolate by connection so unrelated requests cannot
	// share (and poison) one counter bucket.
	return fallback || "default";
}

/** Never pack the output of the recall tool itself (Claude Code namespaces it as mcp__<server>__obs_recall). */
const RECALL_TOOL_NAME = /(?:^|__)obs_recall$/u;

/** @param {any[]} messages @returns {Map<string,{name:string,input:any}>} */
function resolveToolUses(messages) {
	const uses = new Map();
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
				uses.set(block.id, { name: block.name, input: block.input });
			}
		}
	}
	return uses;
}

/**
 * @param {string} [root]
 *
 * Concurrency: multiple Claude Code processes, agent teams, and parallel
 * subagents all hit this one projector. Counter state is keyed by session, and
 * projection for a given session is serialized, so a same-session concurrent
 * request can never race the read-modify-write of the send counters. Sessions
 * and per-session observations are bounded (LRU) so a long-lived gateway cannot
 * grow without limit.
 */
export function createProjector(root = archiveRoot()) {
	/** @type {Map<string, Map<string, number>>} sessionKey -> (observationId -> full sends); insertion order = LRU */
	const sendCounts = new Map();
	/** @type {Map<string, Promise<void>>} sessionKey -> tail of the serialization chain */
	const locks = new Map();
	const reducer = createReducer(loadReducerConfig());
	const MAX_SESSIONS = Number(process.env.SOLPI_MAX_SESSIONS || 2000);
	const MAX_OBS_PER_SESSION = Number(process.env.SOLPI_MAX_OBSERVATIONS || 5000);

	function countsFor(key) {
		let counts = sendCounts.get(key);
		if (counts) {
			sendCounts.delete(key); // LRU touch
			sendCounts.set(key, counts);
			return counts;
		}
		counts = new Map();
		sendCounts.set(key, counts);
		while (sendCounts.size > MAX_SESSIONS) {
			const oldest = sendCounts.keys().next().value;
			sendCounts.delete(oldest);
			locks.delete(oldest);
		}
		return counts;
	}

	/** Serialize projection per session (returns the task's result). */
	function serialize(key, task) {
		const previous = locks.get(key) || Promise.resolve();
		const run = previous.then(task, task);
		locks.set(key, run.then(() => {}, () => {}));
		return run;
	}

	/**
	 * @param {{name:string,value:string}[]} headers
	 * @param {Buffer} bodyBuffer
	 * @param {string} [fallbackKey] per-connection id when no session id is present
	 * @returns {Promise<ProjectionResult>}
	 */
	return async function projectMessagesRequest(headers, bodyBuffer, fallbackKey) {
		/** @type {ProjectionResult} */
		const original = { body: bodyBuffer, changed: false, packed: 0, reduced: 0, notes: [] };
		let body;
		try {
			const parsed = JSON.parse(bodyBuffer.toString("utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return original;
			body = parsed;
		} catch {
			return original;
		}

		const messages = body.messages;
		if (!Array.isArray(messages)) return original;

		const key = sessionKey(headers, body, fallbackKey);

		return serialize(key, async () => {
			const counts = countsFor(key);
			while (counts.size > MAX_OBS_PER_SESSION) counts.delete(counts.keys().next().value);

			const toolUses = resolveToolUses(messages);
			const notes = [];
			let packed = 0;
			let reduced = 0;

			for (const message of messages) {
				if (typeof message !== "object" || message === null) continue;
				const content = message.content;
				if (!Array.isArray(content)) continue;
				for (const block of content) {
					if (typeof block !== "object" || block === null) continue;
					if (block.type !== "tool_result") continue;

					try {
						const toolUseId = String(block.tool_use_id ?? "");
						const toolUse = toolUses.get(toolUseId);
						const toolName = toolUse?.name ?? "";
						if (RECALL_TOOL_NAME.test(toolName)) continue;

						// Evidence-Preserving Reducer first: a verified receipt replaces the
						// long diagnostic log outright. Fail-open -> fall through to packing.
						const receipt = await reducer({ block, toolName, toolInput: toolUse?.input, headers });
						if (receipt !== undefined) {
							block.content = receipt;
							reduced += 1;
							notes.push(`reduced ${toolName} log`);
							continue;
						}

						const observation = buildObservation(block, toolName);
						if (!observation) continue;

						const previousSends = counts.get(observation.id) ?? 0;
						if (previousSends < FULL_SENDS) {
							counts.set(observation.id, previousSends + 1);
							continue;
						}

						await ensureStored(root, observation);
						block.content = placeholderFor(observation);
						counts.set(observation.id, Math.min(FULL_SENDS + 1, previousSends + 1));
						packed += 1;
						notes.push(`packed ${observation.id} (${observation.bytes}B)`);
					} catch (error) {
						notes.push(`skip block: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}

			if (packed === 0 && reduced === 0) return { ...original, notes };
			const serialized = Buffer.from(JSON.stringify(body), "utf8");
			return { body: serialized, changed: true, packed, reduced, notes };
		});
	};
}
