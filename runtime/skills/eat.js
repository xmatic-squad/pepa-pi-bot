// survive.eat — consume the best available food. Picks from the registry-
// derived foods() set rather than a hard-coded list, so a 1.20 server
// without "glow_berries" won't trip the skill.

import { eatBestFood } from "../actions.js";
import { foods } from "./groups.js";

export const skill = Object.freeze({
	id: "survive.eat",
	title: "Eat best food",
	timeoutMs: 20_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const food = (ctx.snapshot?.food ?? 20);
		if (food >= 18) return { ok: false, code: "not_hungry", detail: `food=${food}` };
		const allowed = foods(ctx.bot);
		if (allowed.size === 0) {
			return { ok: false, code: "unsupported_version", detail: "no foods in registry" };
		}
		const inv = ctx.snapshot?.inventory ?? {};
		const carrying = Object.keys(inv).some((name) => allowed.has(name));
		if (!carrying) return { ok: false, code: "no_food_source", detail: "no edible item in inventory" };
		return { ok: true };
	},
	async execute(ctx) {
		const res = await eatBestFood(ctx.bot);
		if (res.ok) {
			return {
				ok: true,
				code: "done",
				detail: res.detail,
				worldDelta: { ate: res.detail?.ate ?? null },
			};
		}
		const msg = String(res.detail ?? "");
		const code = msg.includes("no food in inventory")
			? "no_food_source"
			: msg.includes("timed out")
				? "timeout"
				: "failed";
		return { ok: false, code, detail: res.detail, worldDelta: null };
	},
	validate(ctx, result) {
		return result.ok && !!result.worldDelta?.ate;
	},
});
