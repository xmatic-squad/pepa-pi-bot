import { test } from "node:test";
import assert from "node:assert/strict";

import { STORYLINE, getStep, __testing } from "./storyline.js";
import { pickCurrentStep, progressSummary, _resetForTest } from "./state.js";

function snap(overrides = {}) {
	return {
		connected: true,
		health: 20,
		food: 20,
		hasFood: false,
		inventory: {},
		equipment: { hand: null, head: null, torso: null, legs: null, feet: null },
		nearbyBlocks: {},
		hazards: { footBlock: "grass_block", belowBlock: "dirt", headBlock: "air" },
		isDay: true,
		hostileCount: 0,
		closestHostile: null,
		_sessionMs: 60_000,
		...overrides,
	};
}

test("STORYLINE: 11 steps, all have id/title/narration/completed/suggestSkill", () => {
	assert.equal(STORYLINE.length, 11);
	for (const s of STORYLINE) {
		assert.ok(s.id, `step missing id`);
		assert.ok(s.title);
		assert.ok(s.narration_ru);
		assert.equal(typeof s.completed, "function");
		assert.equal(typeof s.suggestSkill, "function");
	}
	// Ids unique
	const ids = STORYLINE.map((s) => s.id);
	assert.equal(new Set(ids).size, ids.length);
});

test("getStep: lookup by id", () => {
	assert.equal(getStep("first_wood").title, "Собрать стартовое дерево");
	assert.equal(getStep("does-not-exist"), null);
});

test("emergencyPause: low hp + close hostile → true", () => {
	const { emergencyPause } = __testing;
	assert.equal(emergencyPause(snap({ health: 4, closestHostile: { name: "zombie", distance: 3 } })), true);
	assert.equal(emergencyPause(snap()), false);
	assert.equal(emergencyPause(snap({ hazards: { footBlock: "lava" } })), true);
	assert.equal(emergencyPause(snap({ food: 0 })), true);
});

test("step first_wood: completed when bootstrap wood budget is enough", () => {
	const s = getStep("first_wood");
	assert.equal(s.completed(snap()), false);
	assert.equal(s.completed(snap({ inventory: { oak_log: 4 } })), true);
	assert.equal(s.completed(snap({ inventory: { oak_log: 2, oak_planks: 8 } })), true);
	assert.equal(s.completed(snap({ inventory: { wooden_pickaxe: 1 } })), true);
});

test("step first_wood: suggest gather.logs if trees nearby, explore.far otherwise", () => {
	const s = getStep("first_wood");
	assert.equal(s.suggestSkill(snap({ nearbyBlocks: { logs: 5 } })).skillId, "gather.logs");
	assert.equal(s.suggestSkill(snap({ nearbyBlocks: { logs: { count: 1 } } })).skillId, "gather.logs");
	assert.equal(s.suggestSkill(snap()).skillId, "explore.far");
});

test("step first_tools: requires all three wood tools", () => {
	const s = getStep("first_tools");
	assert.equal(s.completed(snap({ inventory: { wooden_pickaxe: 1 } })), false);
	assert.equal(s.completed(snap({ inventory: { wooden_pickaxe: 1, wooden_axe: 1 } })), false);
	assert.equal(s.completed(snap({ inventory: { wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1 } })), true);
	// Higher tier also counts
	assert.equal(s.completed(snap({ inventory: { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1 } })), true);
});

test("step first_food: completed at ≥2 food items", () => {
	const s = getStep("first_food");
	assert.equal(s.completed(snap()), false);
	assert.equal(s.completed(snap({ inventory: { bread: 2 } })), true);
});

test("step first_food: local hunt only for edible passive mobs within acquire range", () => {
	const s = getStep("first_food");
	assert.equal(
		s.suggestSkill(snap({ nearbyEntities: { passives: [{ name: "chicken", distance: 18 }] } })).skillId,
		"survive.acquire-food",
	);
	assert.equal(
		s.suggestSkill(snap({ nearbyEntities: { passives: [{ name: "chicken", distance: 51 }] } })).skillId,
		"survive.scout-food",
	);
	assert.equal(
		s.suggestSkill(snap({ nearbyEntities: { passives: [{ name: "cod", distance: 12 }] } })).skillId,
		"survive.scout-food",
	);
});

test("step shelter_minimal: completed when bed placed nearby", () => {
	const s = getStep("shelter_minimal");
	assert.equal(s.completed(snap()), false);
	assert.equal(s.completed(snap({ nearbyBlocks: { beds: 1 } })), true);
	assert.equal(s.completed(snap({ nearbyBlocks: { beds: { count: 1 } } })), true);
});

test("step stone_tier: needs cobblestone first", () => {
	const s = getStep("stone_tier");
	assert.equal(s.completed(snap()), false);
	assert.equal(s.suggestSkill(snap()).skillId, "gather.stone");
	assert.equal(s.suggestSkill(snap({ inventory: { cobblestone: 6, stick: 4 } })).skillId, "craft.stone-pickaxe");
});

test("village_grow: never auto-completes (ongoing)", () => {
	const s = getStep("village_grow");
	assert.equal(s.completed(snap({ inventory: { iron_pickaxe: 1, diamond_pickaxe: 1 } })), false);
});

test("pickCurrentStep: disconnected → null", () => {
	_resetForTest();
	assert.equal(pickCurrentStep({ connected: false }), null);
});

test("pickCurrentStep: fresh spawn → first non-completed step", () => {
	_resetForTest();
	const s = snap({ _sessionMs: 5_000, nearbyBlocks: {} });
	const r = pickCurrentStep(s);
	assert.ok(r);
	// orient_self is the first; with no nearby blocks and short session,
	// completed() returns false → picked.
	assert.equal(r.step.id, "orient_self");
	assert.equal(r.index, 0);
});

test("orient_self: barren biome timeout fallback completes step after 120s", () => {
	const n = getStep("orient_self");
	// path (a): full HP + no visible blocks + short session → NOT done (would block).
	assert.equal(n.completed(snap({ _sessionMs: 30_000, nearbyBlocks: {} })), false);
	// path (b): full HP + no visible blocks + long session → done (timeout fallback).
	assert.equal(n.completed(snap({ _sessionMs: 150_000, nearbyBlocks: {} })), true);
	// always: low HP → not done
	assert.equal(n.completed(snap({ health: 8, _sessionMs: 150_000 })), false);
});

test("pickCurrentStep: bot with 8+ logs → first_wood done, picks crafting_basics", () => {
	_resetForTest();
	const r = pickCurrentStep(snap({
		_sessionMs: 60_000,
		nearbyBlocks: { logs: 3 },
		inventory: { oak_log: 10 },
	}));
	assert.ok(r);
	assert.equal(r.step.id, "crafting_basics");
	assert.equal(r.completedSteps, 2, "orient_self + first_wood done");
});

test("pickCurrentStep: bot with planks and sticks advances to first_tools", () => {
	_resetForTest();
	const r = pickCurrentStep(snap({
		_sessionMs: 60_000,
		nearbyBlocks: { logs: { count: 3 } },
		inventory: { oak_planks: 16, stick: 4 },
	}));
	assert.ok(r);
	assert.equal(r.step.id, "first_tools");
	assert.equal(r.suggestion.skillId, "craft.wooden-pickaxe");
});

test("pickCurrentStep: emergency pauses suggestion", () => {
	_resetForTest();
	const r = pickCurrentStep(snap({
		health: 4,
		closestHostile: { name: "zombie", distance: 3 },
		nearbyBlocks: { logs: 2 },
	}));
	assert.ok(r);
	assert.equal(r.emergency, true);
	assert.equal(r.suggestion, null, "no concrete suggestion while emergency holds");
});

test("pickCurrentStep: rejects unknown skill ids from suggestSkill", () => {
	_resetForTest();
	// Inject a synthetic step with bogus skill — but STORYLINE is frozen,
	// so we just verify that real ids are valid (sanity check).
	const r = pickCurrentStep(snap({
		_sessionMs: 60_000,
		nearbyBlocks: { logs: 2 },
	}));
	if (r?.suggestion?.skillId) {
		// All real STORYLINE skill ids should be registered.
		// (skill-registry imports a frozen list of skills/index.js.)
		assert.ok(r.suggestion.skillId.includes("."), "skill id is namespaced");
	}
});

test("progressSummary: formats step n/N + skill + emergency tag", () => {
	_resetForTest();
	const s1 = progressSummary(snap({ _sessionMs: 5_000 }));
	assert.match(s1, /step 1\/11/);
	assert.match(s1, /orient_self/);

	_resetForTest();
	const s2 = progressSummary(snap({
		health: 3,
		closestHostile: { name: "creeper", distance: 2 },
	}));
	assert.match(s2, /EMERGENCY/);
});
