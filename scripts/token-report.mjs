/*
 * Aggregate the gateway's token accounting into a saving/cost report.
 *
 *   node scripts/token-report.mjs [path-to-tokens.jsonl]
 *
 * Prices default to env SOLPI_PRICE_IN / SOLPI_PRICE_OUT (USD per 1M tokens) and
 * SOLPI_PRICE_CACHE_READ (USD per 1M cache-read tokens). They are NOT hardcoded,
 * because only you know your model's current pricing.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const path = process.argv[2] || join(root, "gateway", "logs", "tokens.jsonl");

if (!existsSync(path)) {
	console.log(`no accounting file at ${path}`);
	process.exit(0);
}

const records = readFileSync(path, "utf8")
	.split("\n")
	.filter((line) => line.trim().length > 0)
	.map((line) => { try { return JSON.parse(line); } catch { return null; } })
	.filter(Boolean);

const requests = records.filter((r) => r.kind === "request");
const usages = records.filter((r) => r.kind === "usage");
const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

const savedTokens = sum(requests, "savedTokens");
const inputTokens = sum(usages, "input_tokens");
const outputTokens = sum(usages, "output_tokens");
const cacheRead = sum(usages, "cache_read_input_tokens");
const cacheWrite = sum(usages, "cache_creation_input_tokens");

const priceIn = Number(process.env.SOLPI_PRICE_IN || 0);
const priceOut = Number(process.env.SOLPI_PRICE_OUT || 0);
const priceCacheRead = Number(process.env.SOLPI_PRICE_CACHE_READ || priceIn * 0.1);
const priceCacheWrite = Number(process.env.SOLPI_PRICE_CACHE_WRITE || priceIn * 1.25);

const usd = (tokens, pricePerM) => (tokens * pricePerM) / 1_000_000;

console.log(`accounting file: ${path}`);
console.log(`records: ${records.length}  (requests ${requests.length}, usage ${usages.length})\n`);

console.log("REQUEST-SIDE REDUCTION (estimated, bytes/4)");
console.log(`  body bytes before : ${sum(requests, "bodyBytesBefore").toLocaleString()}`);
console.log(`  body bytes after  : ${sum(requests, "bodyBytesAfter").toLocaleString()}`);
console.log(`  saved bytes       : ${sum(requests, "savedBytes").toLocaleString()}`);
console.log(`  saved tokens ~    : ${savedTokens.toLocaleString()}`);
console.log(`  packed / reduced  : ${sum(requests, "packed")} / ${sum(requests, "reduced")}`);

console.log("\nAPI USAGE (real, from responses)");
console.log(`  input tokens      : ${inputTokens.toLocaleString()}`);
console.log(`  output tokens     : ${outputTokens.toLocaleString()}`);
console.log(`  cache read        : ${cacheRead.toLocaleString()}`);
console.log(`  cache write       : ${cacheWrite.toLocaleString()}`);
const grossInput = inputTokens + cacheRead + cacheWrite;
console.log(`  gross input       : ${grossInput.toLocaleString()}  (= input + cache read + cache write)`);

if (priceIn > 0) {
	// As billed, honoring the cache read/write prices.
	const actual = usd(inputTokens, priceIn) + usd(outputTokens, priceOut) + usd(cacheRead, priceCacheRead) + usd(cacheWrite, priceCacheWrite);
	const withoutPacking = usd(inputTokens + savedTokens, priceIn) + usd(outputTokens, priceOut) + usd(cacheRead, priceCacheRead) + usd(cacheWrite, priceCacheWrite);
	// Cache-free counterfactual: every input token billed at the full input price.
	const noCacheActual = usd(grossInput, priceIn) + usd(outputTokens, priceOut);
	const noCacheWithoutPacking = usd(grossInput + savedTokens, priceIn) + usd(outputTokens, priceOut);

	console.log("\nCOST - AS BILLED (with prompt caching)");
	console.log(`  actual            : $${actual.toFixed(4)}`);
	console.log(`  without packing   : $${withoutPacking.toFixed(4)}`);
	console.log(`  saved             : $${(withoutPacking - actual).toFixed(4)}  (${((1 - actual / withoutPacking) * 100).toFixed(1)}%)`);

	console.log("\nCOST - CACHE-FREE (hypothetical: every input token at full price)");
	console.log(`  actual            : $${noCacheActual.toFixed(4)}`);
	console.log(`  without packing   : $${noCacheWithoutPacking.toFixed(4)}`);
	console.log(`  saved             : $${(noCacheWithoutPacking - noCacheActual).toFixed(4)}  (${((1 - noCacheActual / noCacheWithoutPacking) * 100).toFixed(1)}%)`);
	console.log("  note: cache read is billed at ~10% of input, so the as-billed saving is");
	console.log("        smaller than the cache-free saving whenever packed bytes were cache reads.");
	console.log("        The cache-free view ignores that discount; it is not an actual bill.");
} else {
	console.log("\n(set SOLPI_PRICE_IN / SOLPI_PRICE_OUT to compute cost)");
}
