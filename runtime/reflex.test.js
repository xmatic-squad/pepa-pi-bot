// Tests for the new curriculum-driven scheduler in runtime/reflex.js.
// We exercise runTick with synthetic snapshots + a recording ctx so we can
// assert which reflex fires and what gets dispatched.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runTick } from "./reflex.js";

function vec(x, y, z) {
	return {
		x,
		y,
		z,
		distanceTo(other) {
			return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
		},
		offset(dx, dy, dz) {
			return vec(this.x + dx, this.y + dy, this.z + dz);
		},
	};
}

function makeCombatBot({ removeOnAttack = false } = {}) {
	return {
		attacks: 0,
		entity: { position: vec(0, 64, 0) },
		entities: {
			zombie1: { name: "zombie", height: 1.8, position: vec(3, 64, 0) },
		},
		inventory: { items: () => [] },
		lookAt: async () => {},
		attack() {
			this.attacks++;
			if (removeOnAttack) delete this.entities.zombie1;
		},
	};
}

function makeCtx({
	snapshot,
	busy = false,
	bot = { entities: {}, entity: { position: { x: 0, y: 64, z: 0 } } },
	skillBackoff,
	lastEatAt = 0,
	lastSleepAttemptAt = 0,
	lastCurriculumAt = 0,
	metrics,
	disableManifesto = true, // curriculum branch tests don't construct
	                          // full snapshots; manifesto is exercised by
	                          // runtime/manifesto/state.test.js separately.
} = {}) {
	const dispatches = [];
	const ctx = {
		bot,
		snapshot,
		busy,
		currentActionLabel: null,
		lastEatAt,
		lastSleepAttemptAt,
		lastCurriculumAt,
		skillBackoff,
		metrics,
		disableManifesto,
		dispatch(fn, label, opts = {}) {
			dispatches.push({ fn, label, opts });
		},
	};
	return { ctx, dispatches };
}

test("busy ctx returns skipped without dispatching", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: { connected: true, curriculum: { plan: { skillId: "gather.logs" } } },
		busy: true,
		currentActionLabel: "chopping",
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "busy");
	assert.equal(out.action, "skipped");
	assert.equal(dispatches.length, 0);
});

test("disconnected snapshot → no dispatch", () => {
	const { ctx, dispatches } = makeCtx({ snapshot: { connected: false } });
	const out = runTick(ctx);
	assert.equal(out, null);
	assert.equal(dispatches.length, 0);
});

test("mode hit dispatches the returned skill immediately", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 4,
			food: 10,
			hasFood: true,
			inventory: { bread: 1 },
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "mode:self_preservation");
	assert.equal(out.action, "dispatched");
	assert.equal(dispatches[0].label, "survive.eat");
});

test("defend wins over curriculum when hostile in melee", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			closestHostile: { name: "zombie", distance: 3 },
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "defend");
	assert.match(dispatches[0].label, /attack zombie/);
});

test("defend attack does not report success while hostile remains nearby", async () => {
	const bot = makeCombatBot();
	const { ctx, dispatches } = makeCtx({
		bot,
		snapshot: {
			connected: true,
			health: 20,
			closestHostile: { name: "zombie", distance: 3 },
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	ctx.defendAttackMaxSwings = 2;
	ctx.defendAttackSettleMs = 0;

	const out = runTick(ctx);
	assert.equal(out.reflex, "defend");
	const res = await dispatches[0].fn();
	assert.equal(res.ok, false);
	assert.equal(res.code, "hostile_still_near");
	assert.equal(bot.attacks, 2);
});

test("defend flees after a verified attack leaves hostile in reach", () => {
	const bot = makeCombatBot();
	const { ctx, dispatches } = makeCtx({
		bot,
		snapshot: {
			connected: true,
			health: 20,
			closestHostile: { name: "zombie", distance: 3 },
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	const first = runTick(ctx);
	assert.equal(first.reflex, "defend");
	dispatches[0].opts.onComplete({ ok: false, code: "hostile_still_near" });

	const second = runTick(ctx);
	assert.equal(second.reflex, "defend");
	assert.equal(second.kind, "defend-flee");
	assert.equal(dispatches[1].label, "flee from zombie");
});

test("defend flees after repeated attack successes still leave hostile in reach", () => {
	const bot = makeCombatBot();
	const { ctx, dispatches } = makeCtx({
		bot,
		snapshot: {
			connected: true,
			health: 20,
			closestHostile: { name: "zombie", distance: 3 },
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});

	const first = runTick(ctx);
	assert.equal(first.kind, "defend-attack");
	dispatches[0].opts.onComplete({ ok: true, code: "done" });

	const second = runTick(ctx);
	assert.equal(second.kind, "defend-attack");
	dispatches[1].opts.onComplete({ ok: true, code: "done" });

	const third = runTick(ctx);
	assert.equal(third.reflex, "defend");
	assert.equal(third.kind, "defend-flee");
	assert.equal(dispatches[2].label, "flee from zombie");
});

test("eat wins over curriculum when food low and bot has food in inventory", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 10,
			// 2026-05-26: eat reflex now requires actual food in inventory
			// to avoid the eat-spam loop that fired every tick on empty
			// inventory.
			inventory: { bread: 1 },
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "eat");
	assert.equal(dispatches[0].label, "eat");
});

test("eat reflex does NOT dispatch when no food in inventory (no spam)", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 10,
			inventory: { dirt: 1 },
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	const out = runTick(ctx);
	// Falls through to curriculum.
	assert.equal(out.reflex, "curriculum");
});

test("curriculum dispatches suggested skill by id", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	assert.equal(dispatches[0].label, "gather.logs");
	assert.ok(typeof dispatches[0].opts.onComplete === "function");
});

test("manifesto: hungry bot with no food drives survive.acquire-food (overrides curriculum plan)", () => {
	const { ctx, dispatches } = makeCtx({
		disableManifesto: false,
		snapshot: {
			connected: true,
			health: 20,
			food: 12,
			hasFood: false,
			inventory: {}, // no food, no tools
			equipment: {},
			nearbyBlocks: {},
			hazards: { footBlock: "grass_block", belowBlock: "dirt", headBlock: "air" },
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	assert.equal(dispatches[0].label, "survive.acquire-food", "manifesto L1 food took over");
	assert.equal(ctx.activeNeed?.need?.id, "food");
});

test("manifesto: well-fed bot with all wood tools defers to curriculum plan", () => {
	const { ctx, dispatches } = makeCtx({
		disableManifesto: false,
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			hasFood: true,
			inventory: {
				bread: 8,
				wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1,
				white_bed: 1,
			},
			equipment: {},
			nearbyBlocks: { beds: 1 },
			hazards: { footBlock: "grass_block", belowBlock: "dirt", headBlock: "air" },
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	// L4 tools_stone unmet → gather.stone takes precedence even if curriculum says logs
	assert.equal(dispatches[0].label, "gather.stone");
	assert.equal(ctx.activeNeed?.need?.id, "tools_stone");
});

test("curriculum falls back to wander when no plan", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: null,
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	assert.equal(dispatches[0].label, "wander");
});

test("curriculum falls back to wander when skill id is unknown", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "shelter.assemble" } }, // not registered yet
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	assert.match(dispatches[0].label, /^wander/);
});

test("curriculum honours per-skill backoff", () => {
	const future = Date.now() + 30_000;
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.stone" } },
		},
		skillBackoff: { "gather.stone": future },
	});
	const out = runTick(ctx);
	// Backoff blocks the curriculum reflex; idle still won't fire on this
	// tick (idleCounter not at the 20-tick mark) so runTick yields.
	assert.equal(out, null);
	assert.equal(dispatches.length, 0);
});

test("wander-hint backoff swaps skill for wander on the next tick", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
		skillBackoff: { __wander_hint__: Date.now() + 30_000 },
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	assert.equal(dispatches[0].label, "wander");
});

test("recent repeated skill timeouts trigger metric recovery", () => {
	const now = Date.now();
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
		metrics: {
			snapshot: () => ({
				"gather.logs": { ok: 0, fail: 3, lastTs: now, lastCode: "timeout" },
			}),
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	assert.equal(out.kind, "curriculum-metric-recovery");
	assert.equal(dispatches[0].label, "explore.far");
	assert.ok((ctx.skillBackoff?.["gather.logs"] ?? 0) > Date.now());
});

test("recent movement timeouts trigger tunnel recovery", () => {
	const now = Date.now();
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
		metrics: {
			snapshot: () => ({
				"explore.far": { ok: 0, fail: 1, lastTs: now, lastCode: "timeout" },
			}),
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	assert.equal(out.kind, "curriculum-metric-recovery");
	assert.equal(dispatches[0].label, "recovery.tunnel-out");
});

test("successful tunnel recovery clears movement-timeout trigger", () => {
	const now = Date.now();
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
		metrics: {
			snapshot: () => ({
				"explore.far": { ok: 0, fail: 1, lastTs: now - 5_000, lastCode: "timeout" },
				"recovery.tunnel-out": { ok: 1, fail: 0, lastTs: now, lastCode: "done" },
			}),
		},
	});
	const out = runTick(ctx);
	assert.equal(out.reflex, "curriculum");
	assert.equal(out.kind, "curriculum-skill");
	assert.equal(dispatches[0].label, "gather.logs");
});

test("onComplete sets wander hint when skill recovery says so", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	runTick(ctx);
	const cb = dispatches[0].opts.onComplete;
	cb({ ok: false, code: "no_target", recovery: { hint: "wander" } });
	assert.ok((ctx.skillBackoff?.__wander_hint__ ?? 0) > Date.now());
});

test("onComplete clears wander hint on success", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
		skillBackoff: { __wander_hint__: Date.now() + 30_000 },
	});
	// With wander hint active, first tick will choose wander, not gather.logs.
	runTick(ctx);
	// Simulate the wander completing and clearing the hint manually since
	// wander is dispatched via actions.js directly (no recover hint).
	ctx.skillBackoff.__wander_hint__ = 0;

	// Next tick — past the curriculum cooldown.
	ctx.lastCurriculumAt = 0;
	const { ctx: ctx2, dispatches: dispatches2 } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.logs" } },
		},
	});
	runTick(ctx2);
	dispatches2[0].opts.onComplete({ ok: true, code: "done" });
	assert.equal(ctx2.skillBackoff.__wander_hint__, 0);
});

test("onComplete sets per-skill backoff on cooldown-class failures", () => {
	const { ctx, dispatches } = makeCtx({
		snapshot: {
			connected: true,
			health: 20,
			food: 20,
			isDay: true,
			curriculum: { plan: { skillId: "gather.stone" } },
		},
	});
	runTick(ctx);
	const cb = dispatches[0].opts.onComplete;
	cb({ ok: false, code: "missing_tool", detail: "no pickaxe" });
	assert.ok((ctx.skillBackoff?.["gather.stone"] ?? 0) > Date.now());
});
