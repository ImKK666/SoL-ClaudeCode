/*
 * Vendor the shared contract into the plugin so the plugin is self-contained.
 *
 * The gateway imports shared/*.mjs directly from the repo. A distributable
 * Claude Code plugin cannot reach outside its directory, so we copy the shared
 * modules into plugin/vendor/ and the MCP server imports them from there.
 * Run this after changing anything under shared/.
 */

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "shared");
const target = join(root, "plugin", "vendor");

mkdirSync(target, { recursive: true });
let count = 0;
for (const entry of readdirSync(source)) {
	if (!entry.endsWith(".mjs")) continue;
	copyFileSync(join(source, entry), join(target, entry));
	count += 1;
}
console.log(`vendored ${count} shared module(s) -> plugin/vendor`);
