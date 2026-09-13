import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	buildObservation,
	ensureStored,
	isObservationId,
	objectPath,
	placeholderFor,
	readRecallChunk,
	searchObservation,
	THRESHOLD_BYTES,
} from "../shared/observation-pack.mjs";
import { createProjector } from "../gateway/lib/project.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".tmp-observation-pack");
rmSync(root, { recursive: true, force: true });

const marker = "NEEDLE_42";
const big = `${"line filler\n".repeat(500)}${marker}\n${"tail filler\n".repeat(500)}`;

test("builds and archives an observation, then recalls it exactly", async () => {
	const obs = buildObservation({ type: "tool_result", tool_use_id: "t1", content: big }, "Bash");
	assert.ok(obs);
	assert.ok(isObservationId(obs.id));
	assert.ok(obs.bytes > THRESHOLD_BYTES);

	await ensureStored(root, obs);
	const path = objectPath(root, obs.id);
	const chunk = await readRecallChunk(path, 0, { maxBytes: 16 * 1024, maxLines: 400 });
	assert.ok(chunk.bytes > 0);
	assert.equal(chunk.nextOffset, chunk.bytes);
	assert.equal(chunk.eof, false);

	const search = await searchObservation(path, Buffer.from(marker, "utf8"), 0, 16 * 1024, undefined);
	assert.equal(search.matches.length, 1);
	assert.ok(search.matches[0].context.includes(marker));
});

test("placeholder is stable, references the id, and is far smaller", () => {
	const obs = buildObservation({ type: "tool_result", tool_use_id: "t1", content: big }, "Bash");
	const ph = placeholderFor(obs);
	assert.ok(ph.includes(obs.id));
	assert.ok(ph.includes("obs_recall"));
	assert.ok(Buffer.byteLength(ph) < obs.bytes / 5);
});

test("ineligible tool results are rejected", () => {
	assert.equal(buildObservation({ type: "tool_result", tool_use_id: "t2", content: "tiny" }, "Read"), undefined);
	assert.equal(buildObservation({ type: "tool_result", tool_use_id: "t3", content: big, is_error: true }, "Bash"), undefined);
	assert.equal(buildObservation({ type: "tool_result", tool_use_id: "t4", content: "[obs_recall id=x] ..." }, "mcp__sol-claudecode__obs_recall"), undefined);
});

test("projector sends full for FULL_SENDS then packs, and is fail-open", async () => {
	const projector = createProjector(root);
	const bodyFor = () =>
		Buffer.from(
			JSON.stringify({
				model: "claude-opus-5",
				messages: [
					{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
				],
			}),
			"utf8",
		);
	const headers = [{ name: "X-Claude-Code-Session-Id", value: "sess-test" }];
	assert.equal((await projector(headers, bodyFor())).changed, false);
	assert.equal((await projector(headers, bodyFor())).changed, false);
	const third = await projector(headers, bodyFor());
	assert.equal(third.changed, true);
	assert.equal(third.packed, 1);
	const parsed = JSON.parse(third.body.toString("utf8"));
	const replaced = parsed.messages[1].content[0].content;
	assert.equal(parsed.messages[1].content[0].type, "tool_result");
	assert.ok(typeof replaced === "string" && replaced.includes("obs_recall"));

	const bad = await projector(headers, Buffer.from("not json", "utf8"));
	assert.equal(bad.changed, false);
	assert.equal(bad.body.toString(), "not json");
});
