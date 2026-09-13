import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createProjector } from "../gateway/lib/project.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), ".tmp-concurrency");
rmSync(root, { recursive: true, force: true });

const big = "x".repeat(40) + "\n" + "filler line\n".repeat(4000);

function bodyFor() {
	return Buffer.from(
		JSON.stringify({
			model: "claude-opus-5",
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
			],
		}),
		"utf8",
	);
}

test("concurrent same-session projections are serialized (deterministic full-then-pack)", async () => {
	const projector = createProjector(root);
	const headers = [{ name: "X-Claude-Code-Session-Id", value: "sess-concurrent" }];
	// Every client request carries the original bytes (the placeholder exists only
	// on the wire), so after the FULL_SENDS grace every further send re-packs.
	// Unserialized, all four could read sends=0 and all go full; serialized, we get
	// exactly FULL_SENDS full sends and the rest packed.
	const results = await Promise.all([projector(headers, bodyFor()), projector(headers, bodyFor()), projector(headers, bodyFor()), projector(headers, bodyFor())]);
	const changed = results.filter((r) => r.changed).length;
	assert.equal(changed, 2, `expected exactly 2 packs (4 sends - FULL_SENDS=2), got ${changed}`);
});

test("different sessions do not share counters", async () => {
	const projector = createProjector(root);
	const a = [{ name: "X-Claude-Code-Session-Id", value: "sess-a" }];
	const b = [{ name: "X-Claude-Code-Session-Id", value: "sess-b" }];
	const first = await projector(a, bodyFor());
	const otherSession = await projector(b, bodyFor());
	assert.equal(first.changed, false, "session a first send is full");
	assert.equal(otherSession.changed, false, "session b first send is full");
});

test("missing session header falls back to the provided connection key", async () => {
	const projector = createProjector(root);
	const send = () => projector([], bodyFor(), "conn-42");
	assert.equal((await send()).changed, false);
	assert.equal((await send()).changed, false);
	assert.equal((await send()).changed, true, "third send packs within the same connection bucket");
});
