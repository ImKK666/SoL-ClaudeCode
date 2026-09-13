/*
 * Gateway-side evidence-preserving reducer.
 *
 * Provider-agnostic apply path: detect a long diagnostic Bash result, archive
 * it, hand it to the configured reducer provider, and accept the receipt only
 * when validateReceipt proves its quotes against the archive. Any miss returns
 * undefined, leaving the block for the ObservationPack path (or untouched).
 *
 * Providers (SOLCLAUDECODE_REDUCER_PROVIDER):
 *   none      default — mechanism off, zero cost.
 *   command   run SOLCLAUDECODE_REDUCER_COMMAND; it reads the reducer input on stdin and
 *             prints the receipt JSON on stdout. No credentials involved.
 *   openai    OpenAI-compatible chat completions (SOLCLAUDECODE_REDUCER_BASE_URL/_KEY/_MODEL).
 *   anthropic Opt-in. Reuses the intercepted request's Authorization header and
 *             calls a small Claude model as the reducer. This spends the same
 *             subscription the user is already spending; enable deliberately.
 *
 * Fail-open: every provider error, timeout, invalid receipt, or non-shrinking
 * receipt yields undefined.
 */

import { spawn } from "node:child_process";
import {
	archiveBody,
	DEFAULT_MAX_OUTPUT_TOKENS,
	DEFAULT_TIMEOUT_MS,
	DIAGNOSTIC_COMMAND,
	LIKELY_SECRET,
	MAX_CHARS,
	MIN_BYTES,
	reducerArchiveRoot,
	reducerInput,
	reducerInstructions,
	receiptText,
	validateReceipt,
} from "../../shared/evidence-reducer.mjs";

/**
 * Extract tool_result text WITHOUT excluding errors — the reducer's whole point
 * is the failing diagnostic log. (ObservationPack's textFromToolResult rejects
 * is_error blocks on purpose, so it cannot be reused here.)
 * @param {any} block
 */
function textFromBlock(block) {
	const content = block?.content;
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

const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/** @param {Record<string,string|undefined>} [env] */
export function loadReducerConfig(env = process.env) {
	const provider = env.SOLCLAUDECODE_REDUCER_PROVIDER || "none";
	return {
		provider,
		model:
			provider === "anthropic"
				? env.SOLCLAUDECODE_REDUCER_MODEL || DEFAULT_ANTHROPIC_MODEL
				: env.SOLCLAUDECODE_REDUCER_MODEL || DEFAULT_OPENAI_MODEL,
		command: env.SOLCLAUDECODE_REDUCER_COMMAND || "",
		baseUrl: (env.SOLCLAUDECODE_REDUCER_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
		apiKey: env.SOLCLAUDECODE_REDUCER_API_KEY || "",
		maxOutputTokens: Number(env.SOLCLAUDECODE_REDUCER_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS),
		timeoutMs: Number(env.SOLCLAUDECODE_REDUCER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
	};
}

/** @returns {Promise<{ok:boolean, outputText:string, provider:string, model:string, totalTokens:number, stopReason?:string, errorMessage?:string}>} */
async function callCommandProvider(config, input) {
	return new Promise((resolve) => {
		const child = spawn(config.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch {}
			resolve({ ok: false, outputText: "", provider: "command", model: config.command, totalTokens: 0, errorMessage: "timeout" });
		}, config.timeoutMs);
		child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
		child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, outputText: "", provider: "command", model: config.command, totalTokens: 0, errorMessage: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				resolve({ ok: false, outputText: "", provider: "command", model: config.command, totalTokens: 0, errorMessage: `exit ${code}: ${stderr.slice(0, 200)}` });
				return;
			}
			resolve({ ok: true, outputText: stdout.trim(), provider: "command", model: config.command, totalTokens: 0 });
		});
		child.stdin.end(input);
	});
}

async function fetchJson(url, options, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		const text = await response.text();
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
		return JSON.parse(text);
	} finally {
		clearTimeout(timer);
	}
}

async function callAnthropicProvider(config, input, headers) {
	let authorization;
	for (const h of headers) if (h.name.toLowerCase() === "authorization") authorization = h.value;
	if (!authorization) return { ok: false, outputText: "", provider: "anthropic", model: config.model, totalTokens: 0, errorMessage: "no intercepted authorization header" };
	try {
		const json = await fetchJson(
			`${config.baseUrl || "https://api.anthropic.com"}/v1/messages`,
			{
				method: "POST",
				headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization },
				body: JSON.stringify({ model: config.model, max_tokens: config.maxOutputTokens, messages: [{ role: "user", content: input }] }),
			},
			config.timeoutMs,
		);
		const outputText = Array.isArray(json.content) ? json.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
		return { ok: true, outputText, provider: "anthropic", model: config.model, totalTokens: json.usage?.input_tokens + json.usage?.output_tokens || 0, stopReason: json.stop_reason };
	} catch (error) {
		return { ok: false, outputText: "", provider: "anthropic", model: config.model, totalTokens: 0, errorMessage: error instanceof Error ? error.message : String(error) };
	}
}

async function callOpenAiProvider(config, input) {
	if (!config.apiKey) return { ok: false, outputText: "", provider: "openai", model: config.model, totalTokens: 0, errorMessage: "SOLCLAUDECODE_REDUCER_API_KEY is not set" };
	try {
		const json = await fetchJson(
			`${config.baseUrl}/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
				body: JSON.stringify({ model: config.model, max_tokens: config.maxOutputTokens, messages: [{ role: "system", content: reducerInstructions() }, { role: "user", content: input }] }),
			},
			config.timeoutMs,
		);
		const outputText = json.choices?.[0]?.message?.content ?? "";
		return { ok: true, outputText, provider: "openai", model: config.model, totalTokens: json.usage?.total_tokens || 0 };
	} catch (error) {
		return { ok: false, outputText: "", provider: "openai", model: config.model, totalTokens: 0, errorMessage: error instanceof Error ? error.message : String(error) };
	}
}

async function callProvider(config, input, headers) {
	if (config.provider === "command" && config.command) return callCommandProvider(config, input);
	if (config.provider === "anthropic") return callAnthropicProvider(config, input, headers);
	if (config.provider === "openai") return callOpenAiProvider(config, input);
	return { ok: false, outputText: "", provider: config.provider, model: config.model, totalTokens: 0, errorMessage: "no reducer provider configured" };
}

/** @param {ReturnType<typeof loadReducerConfig>} config @param {string} [root] */
export function createReducer(config, root = reducerArchiveRoot()) {
	if (config.provider === "none") return async () => undefined;
	const cache = new Map(); // source hash -> successful provider result

	return async function maybeReduce({ block, toolName, toolInput, headers }) {
		try {
			if (toolName !== "Bash" && toolName !== "bash") return undefined;
			const command = typeof toolInput?.command === "string" ? toolInput.command : "";
			if (!command || !DIAGNOSTIC_COMMAND.test(command)) return undefined;

			const body = textFromBlock(block);
			if (body === null) return undefined;
			if (Buffer.byteLength(body, "utf8") < MIN_BYTES) return undefined;
			if (body.length > MAX_CHARS) return undefined;
			if (LIKELY_SECRET.test(body)) return undefined;

			const archive = await archiveBody(root, body);
			let provider = cache.get(archive.hash);
			if (!provider) {
				provider = await callProvider(config, reducerInput(command, block.is_error === true, archive, body), headers);
				if (provider.ok) cache.set(archive.hash, provider);
			}
			if (!provider.ok) return undefined;

			const checked = validateReceipt(provider.outputText, archive, body, block.is_error === true);
			if (!checked.ok) {
				cache.delete(archive.hash);
				return undefined;
			}
			const receipt = receiptText(command, archive, checked.value, provider);
			if (Buffer.byteLength(receipt, "utf8") >= archive.bytes) return undefined;
			return receipt;
		} catch {
			return undefined;
		}
	};
}
