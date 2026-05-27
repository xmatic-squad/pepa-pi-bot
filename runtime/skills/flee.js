// survive.flee — emergency retreat from the nearest hostile. Unlike
// explore.far, this skill explicitly moves away from the hostile entity
// that triggered the mode.

import { fleeFrom } from "../actions.js";

const HOSTILE = new Set([
	"zombie", "skeleton", "creeper", "spider", "witch", "pillager",
	"vindicator", "husk", "stray", "drowned", "phantom", "enderman",
	"slime", "magma_cube", "hoglin", "piglin_brute", "ravager", "warden",
	"breeze", "bogged",
]);

function nearestHostile(bot, { hostileName } = {}) {
	const here = bot?.entity?.position;
	if (!here) return null;
	let best = null;
	for (const e of Object.values(bot.entities ?? {})) {
		if (!e?.position) continue;
		const name = (e.name || "").toLowerCase();
		if (hostileName && name !== String(hostileName).toLowerCase()) continue;
		if (!hostileName && !HOSTILE.has(name)) continue;
		const d = e.position.distanceTo(here);
		if (!best || d < best.distance) best = { entity: e, distance: d };
	}
	return best;
}

export const skill = Object.freeze({
	id: "survive.flee",
	title: "Retreat from the nearest hostile",
	timeoutMs: 40_000,
	preconditions(ctx, args = {}) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const hit = nearestHostile(ctx.bot, args);
		if (!hit) return { ok: false, code: "no_hostile", detail: "no matching hostile entity" };
		return { ok: true };
	},
	async execute(ctx, args = {}) {
		const hit = nearestHostile(ctx.bot, args);
		if (!hit) return { ok: false, code: "no_hostile", detail: "no matching hostile after precondition", worldDelta: null };
		const res = await fleeFrom(ctx.bot, hit.entity, args.distance ?? 16);
		if (res.ok) {
			return {
				ok: true,
				code: "done",
				detail: { ...res.detail, from: hit.entity.name, distance: Math.round(hit.distance * 10) / 10 },
				worldDelta: { fledTo: res.detail?.to ?? null },
			};
		}
		const msg = String(res.detail ?? "");
		const code = msg.includes("timed out") ? "timeout" : "failed";
		return { ok: false, code, detail: res.detail, worldDelta: null };
	},
	recover(ctx, result) {
		if (result.code === "timeout") return { hint: "tunnel-out", reason: "flee path timed out" };
		return null;
	},
});

export const _internal = { nearestHostile };
