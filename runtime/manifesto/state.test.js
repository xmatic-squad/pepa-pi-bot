import { test } from "node:test";
import assert from "node:assert/strict";

import { pickActiveNeed, describeActiveNeed, _resetForTest } from "./state.js";

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
		...overrides,
	};
}

test("pickActiveNeed: disconnected → null", () => {
	_resetForTest();
	assert.equal(pickActiveNeed({ connected: false }), null);
	assert.equal(pickActiveNeed(null), null);
});

test("pickActiveNeed: fresh spawn → L0 alive if zero food", () => {
	_resetForTest();
	const a = pickActiveNeed(snap({ food: 0 }));
	assert.equal(a.need.id, "alive");
	assert.equal(a.skillId, "survive.scout-food");
});

test("pickActiveNeed: hungry (food<14), no food in inventory → L1 food (scout)", () => {
	_resetForTest();
	const a = pickActiveNeed(snap({ food: 8 }));
	assert.equal(a.need.id, "food");
	assert.equal(a.skillId, "survive.scout-food");
});

test("pickActiveNeed: sated (food=20) + empty inventory → skips L1, goes to L2 tools_wood", () => {
	_resetForTest();
	const a = pickActiveNeed(snap());
	assert.equal(a.need.id, "tools_wood", "sated bot works toward tools, not chasing food");
});

test("pickActiveNeed: food covered → L2 tools_wood (gather logs)", () => {
	_resetForTest();
	const a = pickActiveNeed(snap({ inventory: { bread: 8 } }));
	assert.equal(a.need.id, "tools_wood");
	assert.equal(a.skillId, "gather.logs");
});

test("pickActiveNeed: tools wood done → L3 shelter (gather wool)", () => {
	_resetForTest();
	const a = pickActiveNeed(snap({
		inventory: {
			bread: 8,
			wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1,
		},
	}));
	assert.equal(a.need.id, "shelter_basic");
	// no wool, no bed → gather.wool
	assert.equal(a.skillId, "gather.wool");
});

test("pickActiveNeed: shelter done → L4 tools_stone", () => {
	_resetForTest();
	const a = pickActiveNeed(snap({
		nearbyBlocks: { beds: 1 },
		inventory: {
			bread: 8,
			wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1,
		},
	}));
	assert.equal(a.need.id, "tools_stone");
	assert.equal(a.skillId, "gather.stone");
});

test("pickActiveNeed: armor pursue=null → ladder skips to food_security", () => {
	_resetForTest();
	// Everything up through tools_stone satisfied, no armor (pursue=null).
	// Should advance to food_security, not stall.
	const a = pickActiveNeed(snap({
		nearbyBlocks: { beds: 1 },
		inventory: {
			bread: 8,
			wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1,
			stone_pickaxe: 1, stone_axe: 1, stone_sword: 1,
		},
	}));
	assert.equal(a.need.id, "food_security");
	assert.ok(a.blockedNeeds.some((b) => b.id === "armor_basic"), "armor_basic recorded as blocked");
});

test("pickActiveNeed: hostile imminent + low HP → L0 takes over", () => {
	_resetForTest();
	const a = pickActiveNeed(snap({
		health: 6,
		closestHostile: { name: "creeper", distance: 3 },
		inventory: { bread: 8, wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1 },
		nearbyBlocks: { beds: 1 },
	}));
	assert.equal(a.need.id, "alive");
	assert.equal(a.skillId, "survive.flee");
});

test("describeActiveNeed: returns 'L<n> <id> → <skill>'", () => {
	_resetForTest();
	const s = describeActiveNeed(snap({ food: 8 }));
	assert.match(s, /^L1 food → /);
});

test("pickActiveNeed: caches within TTL — same snapshot ref returns same result", () => {
	_resetForTest();
	const s = snap();
	const a = pickActiveNeed(s);
	const b = pickActiveNeed(s);
	assert.equal(a, b, "second call returns cached object");
});
