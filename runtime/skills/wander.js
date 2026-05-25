// explore.wander — pick a random nearby point and path to it. Used as a
// fallback when gather skills can't find a target nearby — better to keep
// the bot moving than to dispatch the same failing skill on every tick.

import { wander } from "../actions.js";

export const skill = Object.freeze({
	id: "explore.wander",
	title: "Wander to a nearby point",
	timeoutMs: 45_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		return { ok: true };
	},
	async execute(ctx, args = {}) {
		const radius = Math.max(6, args.radius ?? 16);
		const res = await wander(ctx.bot, radius);
		if (res.ok) {
			return {
				ok: true,
				code: "done",
				detail: res.detail,
				worldDelta: { movedTo: res.detail?.to ?? null },
			};
		}
		const msg = String(res.detail ?? "");
		const code = msg.includes("timed out")
			? "timeout"
			: msg.includes("No path")
				? "no_safe_path"
				: "failed";
		return { ok: false, code, detail: res.detail, worldDelta: null };
	},
});
