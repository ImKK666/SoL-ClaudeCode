import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, ".tmp-reducer");
const fixture = join(here, "fixtures", "fake-reducer.mjs");

const logText = [
	"running 900 tests",
	...Array.from({ length: 300 }, (_, i) => `test foo_${i} ... ok`),
	"thread 'main' panicked: assertion failed",
	"error: test failed, to rerun pass --lib",
].join("\n");

function bodyFor(command, isError) {
	return Buffer.from(
		JSON.stringify({
			model: "claude-opus-5",
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: logText, is_error: isError }] },
			],
		}),
		"utf8",
	);
}

test("reduces a failing diagnostic log to a verified receipt", async () => {
	rmSync(root, { recursive: true, force: true });
	process.env.SOLCLAUDECODE_HOME = root;
	process.env.SOLCLAUDECODE_REDUCER_PROVIDER = "command";
	process.env.SOLCLAUDECODE_REDUCER_COMMAND = `node ${fixture}`;

	const { createProjector } = await import("../gateway/lib/project.mjs");
	const projector = createProjector(root);
	const body = bodyFor("cargo test", true);
	const result = await projector([{ name: "X-Claude-Code-Session-Id", value: "s" }], body);

	assert.equal(result.reduced, 1);
	const content = JSON.parse(result.body.toString("utf8")).messages[1].content[0].content;
	assert.ok(content.startsWith("sol_pi_evidence_receipt_v1"));
	assert.ok(content.includes("kind=failure"));
	assert.ok(result.body.length < body.length);
});

test("leaves non-diagnostic commands untouched and is fail-open", async () => {
	const { createProjector } = await import("../gateway/lib/project.mjs");
	const projector = createProjector(root);
	const result = await projector([{ name: "X-Claude-Code-Session-Id", value: "s" }], bodyFor("cat notes.txt", false));
	assert.equal(result.reduced, 0);
});
