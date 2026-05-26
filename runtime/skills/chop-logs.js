// gather.logs — find the nearest log block matching the server's log
// registry, path to it, mine it. Wraps the existing actions.js primitive
// while exposing the survival-skill contract (preconditions, timeout,
// structured worldDelta, recovery hint).

import { chopNearestTree } from "../actions.js";
import { logs as logBlocks } from "./groups.js";

export const skill = Object.freeze({
	id: "gather.logs",
	title: "Gather logs",
	timeoutMs: 60_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const known = logBlocks(ctx.bot);
		if (known.size === 0) {
			return { ok: false, code: "unsupported_version", detail: "no log blocks in registry" };
		}
		return { ok: true };
	},
	async execute(ctx) {
		const res = await chopNearestTree(ctx.bot);
		if (res.ok) {
			return {
				ok: true,
				code: "done",
				detail: res.detail,
				worldDelta: {
					choppedAt: res.detail?.at ?? null,
					logType: res.detail?.logType ?? null,
				},
			};
		}
		const msg = String(res.detail ?? "");
		// res.code can come straight from actions.js (silent_dig_failure),
		// otherwise we classify from the detail string.
		const code = res.code
			? res.code
			: (msg.includes("no reachable log") || msg.includes("no log within"))
				? "no_target"
				: msg.includes("timed out")
					? "timeout"
					: "failed";
		return { ok: false, code, detail: res.detail, worldDelta: null };
	},
	validate(ctx, result) {
		return result.ok && !!result.worldDelta?.logType;
	},
	recover(ctx, result) {
		// Tell the caller: if there was no reachable log, switching to wander
		// for ~60 s is the right next move — same heuristic the autonomous
		// reflex already uses.
		if (result.code === "no_target") {
			return { hint: "wander", reason: "no log within 32 blocks" };
		}
		return null;
	},
});
