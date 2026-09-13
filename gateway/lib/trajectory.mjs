/*
 * Trajectory Inspector (gateway side).
 *
 * A bounded, metadata-only execution trace, mirroring SoL-Pi's trajectory
 * inspector: event kind, timestamp, status, model/tool identifiers, byte counts.
 * The gateway never parses responses, so it records request-side facts plus the
 * response byte count it relayed. Prompts and tool output are never stored here.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** @param {string} path */
export function createTrajectory(path) {
	try { mkdirSync(dirname(path), { recursive: true }); } catch {}
	return function record(entry) {
		try {
			appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
		} catch {
			/* observational only: never break the request path */
		}
	};
}
