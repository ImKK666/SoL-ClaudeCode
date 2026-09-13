import { test } from "node:test";
import assert from "node:assert/strict";
import { createResponseUsageScanner, estimateTokens, requestMeta } from "../gateway/lib/accounting.mjs";

test("estimateTokens uses 4 chars per token", () => {
	assert.equal(estimateTokens(0), 0);
	assert.equal(estimateTokens(4), 1);
	assert.equal(estimateTokens(27159), 6790);
});

test("requestMeta extracts model and cache markers without parsing", () => {
	const body = JSON.stringify({ model: "claude-opus-5", messages: [], system: [{ cache_control: { type: "ephemeral" } }] });
	const meta = requestMeta(body);
	assert.equal(meta.model, "claude-opus-5");
	assert.equal(meta.cacheMarkers, 1);
});

test("scans streaming SSE for input, cache, and final output tokens", () => {
	const scanner = createResponseUsageScanner();
	scanner.feed(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":8000,"cache_creation_input_tokens":300,"output_tokens":1}}}\n\n', "utf8"));
	scanner.feed(Buffer.from('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":120}}\n\n', "utf8"));
	scanner.feed(Buffer.from('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":250}}\n\n', "utf8"));
	const usage = scanner.finish();
	assert.equal(usage.input_tokens, 1200);
	assert.equal(usage.cache_read_input_tokens, 8000);
	assert.equal(usage.cache_creation_input_tokens, 300);
	assert.equal(usage.output_tokens, 250);
});

test("handles nested cache_creation usage", () => {
	const scanner = createResponseUsageScanner();
	scanner.feed(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":40,"ephemeral_1h_input_tokens":2},"output_tokens":1}}}\n\n', "utf8"));
	const usage = scanner.finish();
	assert.equal(usage.input_tokens, 10);
	assert.equal(usage.cache_creation_input_tokens, 42);
});

test("scans a non-streaming JSON body", () => {
	const scanner = createResponseUsageScanner();
	scanner.feed(Buffer.from(JSON.stringify({ type: "message", usage: { input_tokens: 42, output_tokens: 7 } }), "utf8"));
	const usage = scanner.finish();
	assert.equal(usage.input_tokens, 42);
	assert.equal(usage.output_tokens, 7);
});

test("returns undefined when no usage is present", () => {
	const scanner = createResponseUsageScanner();
	scanner.feed(Buffer.from("hello world", "utf8"));
	assert.equal(scanner.finish(), undefined);
});
