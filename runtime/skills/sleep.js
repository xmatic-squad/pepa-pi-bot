// survive.sleep — use the action-layer bed primitive through the skill
// contract so priority modes can sleep without bypassing metrics,
// scenario-memory, current-task, and self-improvement evidence.

import { sleepInBed } from "../actions.js";

export const skill = Object.freeze({
	id: "survive.sleep",
	title: "Sleep in or place a carried bed",
	timeoutMs: 45_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		if (ctx.snapshot?.isDay) return { ok: false, code: "daytime", detail: "not night" };
		const inv = ctx.snapshot?.inventory ?? {};
		const hasBed = Object.keys(inv).some((n) => /_bed$/.test(n));
		const knownBed = ctx.snapshot?.locations?.shelter || ctx.snapshot?.locations?.base;
		if (!hasBed && !knownBed) {
			return { ok: false, code: "missing_bed", detail: "no bed in inventory or known shelter" };
		}
		return { ok: true };
	},
	async execute(ctx) {
		const res = await sleepInBed(ctx.bot);
		if (res.ok) {
			return {
				ok: true,
				code: "done",
				detail: res.detail,
				worldDelta: { sleptAt: res.detail?.bedAt ?? ctx.snapshot?.position ?? null },
			};
		}
		const msg = String(res.detail ?? "");
		const code = msg.includes("no bed")
			? "missing_bed"
			: msg.includes("timed out")
				? "timeout"
				: "failed";
		return { ok: false, code, detail: res.detail, worldDelta: null };
	},
	recover(ctx, result) {
		if (result.code === "missing_bed") return { hint: "curriculum", reason: "need bed milestone" };
		return null;
	},
});
