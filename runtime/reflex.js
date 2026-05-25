// Reflex layer: priority-ordered list of pure-script behaviors. Each reflex
// inspects the latest snapshot and either returns a no-op or starts an action.
// LLM is NOT called here. If every reflex declines, the tick yields and we try
// again next interval. Escalation to Pi happens elsewhere, only when the bot
// has been idle/stuck for an extended window.

import { info, warn } from "./log.js";

const REFLEX_LOG = "reflex";

// A reflex returns one of:
//   { action: "noop" }                       — nothing to do
//   { action: "starting", kind, detail }     — kicked off async work
//   { action: "completed", kind, detail }    — fully sync, already done
// Reflexes must NEVER throw — they should log and return noop on failure.

function defendReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (!s.closestHostile) return { action: "noop" };
	if (s.closestHostile.distance > 6) return { action: "noop" };
	// Stub: just log. Real attack/flee logic comes in a follow-up commit.
	info(REFLEX_LOG, `defend: hostile ${s.closestHostile.name} at ${s.closestHostile.distance}m (stub, no action yet)`);
	return { action: "completed", kind: "defend-stub", detail: s.closestHostile };
}

function eatReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (s.food === undefined || s.food >= 16) return { action: "noop" };
	// Stub: log only. consume() integration arrives with the actions module.
	info(REFLEX_LOG, `eat: hunger ${s.food}/20 (stub, no action yet)`);
	return { action: "completed", kind: "eat-stub", detail: { food: s.food } };
}

function sleepReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (s.isDay) return { action: "noop" };
	if (!s.inventory?.["red_bed"] && !s.inventory?.["white_bed"]) return { action: "noop" };
	info(REFLEX_LOG, `sleep: night detected, bed in inventory (stub)`);
	return { action: "completed", kind: "sleep-stub" };
}

function idleReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	// Once every ~10 ticks, log a heartbeat with HP/food/pos. Tunable later.
	ctx.idleCounter = (ctx.idleCounter ?? 0) + 1;
	if (ctx.idleCounter % 10 !== 0) return { action: "noop" };
	info(REFLEX_LOG, `idle: hp=${s.health} food=${s.food} pos=${s.position?.x},${s.position?.y},${s.position?.z}`);
	return { action: "completed", kind: "idle-heartbeat" };
}

const REFLEXES = [
	{ name: "defend", fn: defendReflex },
	{ name: "eat", fn: eatReflex },
	{ name: "sleep", fn: sleepReflex },
	{ name: "idle", fn: idleReflex },
];

export function runTick(ctx) {
	for (const reflex of REFLEXES) {
		let outcome;
		try {
			outcome = reflex.fn(ctx);
		} catch (e) {
			warn(REFLEX_LOG, `reflex ${reflex.name} threw: ${e?.message ?? e}`);
			continue;
		}
		if (!outcome || outcome.action === "noop") continue;
		// First non-noop wins — stop the chain so we don't double-act per tick.
		return { reflex: reflex.name, ...outcome };
	}
	return null;
}
