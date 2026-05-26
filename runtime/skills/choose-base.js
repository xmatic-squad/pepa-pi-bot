// village.choose-base — score the bot's current position as a candidate
// base site, and if it clears the minimum bar, persist it under
// state/<host>/locations.json as "base". The skill is intentionally
// shallow: a single tick at the bot's current footing, no global scan.
// The curriculum can dispatch it repeatedly while the bot wanders, and
// the threshold means most calls will return `code: "too_weak"` and
// move on.

import { scoreCurrentPosition } from "../base-site.js";
import { setLocation, getLocation } from "../locations.js";

const MIN_BASE_SCORE = 8; // out of ~14 max; tuned to "good enough"

export const skill = Object.freeze({
	id: "village.choose-base",
	title: "Score the current spot as a base candidate",
	timeoutMs: 5_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		// If we already have a base, this skill is a no-op the curriculum
		// shouldn't be asking for. Defer gracefully.
		if (getLocation("base")) return { ok: false, code: "already_have_base", detail: "base location already set" };
		return { ok: true };
	},
	async execute(ctx) {
		const result = scoreCurrentPosition(ctx.bot);
		if (!result?.position) {
			return { ok: false, code: "no_position", detail: "bot has no position", worldDelta: null };
		}
		if (result.score < MIN_BASE_SCORE) {
			return {
				ok: false,
				code: "too_weak",
				detail: { score: result.score, reasons: result.reasons },
				worldDelta: null,
			};
		}
		const loc = setLocation("base", {
			x: result.position.x,
			y: result.position.y,
			z: result.position.z,
			dimension: ctx.snapshot?.dimension ?? "overworld",
			radius: 8,
			note: `auto-chosen base, score=${result.score}`,
		});
		return {
			ok: true,
			code: "done",
			detail: { location: loc, score: result.score, reasons: result.reasons },
			worldDelta: { baseAt: { x: loc.x, y: loc.y, z: loc.z }, score: result.score },
		};
	},
	recover(ctx, result) {
		// Most failures (too_weak) want us to wander and re-evaluate.
		if (result.code === "too_weak") return { hint: "wander", reason: "current spot doesn't pass base threshold" };
		return null;
	},
});
