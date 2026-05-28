// Shared skill helpers.
//
// approachBlock — walk up to a target block and look at it, WITHOUT using
// pathfinder's GoalLookAtBlock. That goal raycasts collision boxes only
// (mineflayer-pathfinder #341), so for non-collision targets — crops, torches,
// fences, saplings, buttons — the raycast never hits and the goal is never
// "reached". Instead we GoalNear the block and lookAt its centre, which works
// regardless of the target's collision shape (research QW4).

import pathfinderPkg from "mineflayer-pathfinder";
const { goals } = pathfinderPkg;

export function blockPos(target) {
	const p = target?.position ?? target;
	if (!p || p.x == null) return null;
	return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

export function blockCenter(target) {
	const p = blockPos(target);
	return p ? { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 } : null;
}

export function withinReach(botPos, target, reach = 4) {
	const c = blockCenter(target);
	if (!botPos || !c) return false;
	return Math.hypot(botPos.x - c.x, botPos.y - c.y, botPos.z - c.z) <= reach;
}

// Returns { ok, code, distance? }. Uses ctx.motion.gotoSafe when available
// (structured, can't hang); falls back to a raw goto otherwise.
export async function approachBlock(ctx, target, opts = {}) {
	const bot = ctx?.bot;
	const pos = blockPos(target);
	if (!bot || !pos) return { ok: false, code: "no_target" };

	const reach = opts.reach ?? 3;
	const reachCheck = opts.reachCheck ?? 4;

	if (!withinReach(bot.entity?.position, target, reachCheck)) {
		const goal = new goals.GoalNear(pos.x, pos.y, pos.z, reach);
		let res;
		if (ctx.motion?.gotoSafe) {
			res = await ctx.motion.gotoSafe(goal, { timeoutMs: opts.timeoutMs ?? 20_000, label: "approach_block" });
		} else {
			try {
				await bot.pathfinder.goto(goal);
				res = { ok: true, code: "reached" };
			} catch (e) {
				res = { ok: false, code: "error", detail: e?.message ?? String(e) };
			}
		}
		if (!res.ok && !withinReach(bot.entity?.position, target, reachCheck)) {
			return { ok: false, code: res.code, detail: res.detail ?? null };
		}
	}

	// Look at the block centre — NOT GoalLookAtBlock (issue #341).
	try { await bot.lookAt(blockCenter(target), true); } catch {}

	const here = bot.entity?.position;
	const c = blockCenter(target);
	const distance = here && c ? Math.round(Math.hypot(here.x - c.x, here.y - c.y, here.z - c.z) * 10) / 10 : null;
	return { ok: true, code: "reached", distance };
}

export const _internal = { blockPos, blockCenter, withinReach };
