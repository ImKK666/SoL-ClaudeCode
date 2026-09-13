/*
 * Archive garbage collection.
 *
 * The content-addressed archive never deletes itself, so a long-lived gateway
 * grows without bound. Remove objects older than N days (default 14):
 *
 *   node scripts/solpi-gc.mjs [days]
 *   SOLPI_GC_DAYS=30 node scripts/solpi-gc.mjs
 *
 * Only archived tool results and reduced logs are touched — no configuration.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { archiveRoot } from "../shared/observation-pack.mjs";

const days = Number(process.argv[2] || process.env.SOLPI_GC_DAYS || 14);
const cutoff = Date.now() - days * 86_400_000;
const root = archiveRoot();

let removed = 0;
let kept = 0;
let bytes = 0;

function sweep(directory) {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			sweep(path);
		} else if (entry.isFile()) {
			try {
				const stats = statSync(path);
				if (stats.mtimeMs < cutoff) {
					bytes += stats.size;
					unlinkSync(path);
					removed += 1;
				} else {
					kept += 1;
				}
			} catch {
				/* raced with another cleaner: ignore */
			}
		}
	}
}

sweep(join(root, "observation-pack", "objects"));
sweep(join(root, "evidence-preserving-reducer", "objects"));
console.log(`archive GC at ${root}: removed ${removed} object(s) (${(bytes / 1e6).toFixed(2)} MB), kept ${kept} (age < ${days}d)`);
