// Fake reducer fixture for tests: reads the reducer input on stdin, emits a
// valid receipt quoting the first error-looking line.
import { readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const hash = input.match(/source_sha256=([a-f0-9]{64})/)?.[1] ?? "";
const isError = /(^|\n)is_error=true(\n|$)/.test(input);
const log = input.split("<untrusted_log>\n")[1]?.split("\n</untrusted_log>")[0] ?? "";
const quote = log.split("\n").find((line) => /error/i.test(line)) ?? log.split("\n")[0] ?? "x";
process.stdout.write(
	JSON.stringify({
		schema: "sol-pi-evidence-receipt/1",
		source_sha256: hash,
		status: isError ? "failure" : "success",
		uncertain: false,
		evidence: [{ kind: isError ? "failure" : "summary", quote }],
	}),
);
