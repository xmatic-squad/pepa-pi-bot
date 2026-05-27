import { test } from "node:test";
import assert from "node:assert/strict";

import { NEEDS, getNeed, __testing } from "./needs.js";

function snap(overrides = {}) {
	return {
		connected: true,
		health: 20,
		food: 20,
		hasFood: false,
		inventory: {},
		equipment: { hand: null, head: null, torso: null, legs: null, feet: null },
		nearbyBlocks: {},
		hazards: { lavaNearby: false, inFluid: false, footBlock: "grass_block", belowBlock: "dirt", headBlock: "air" },
		isDay: true,
		hostileCount: 0,
		closestHostile: null,
		...overrides,
	};
}

test("ladder: 11 levels in order, ids unique", () => {
	assert.equal(NEEDS.length, 11);
	for (let i = 0; i < NEEDS.length; i++) {
		assert.equal(NEEDS[i].level, i);
	}
	const ids = NEEDS.map((n) => n.id);
	assert.equal(new Set(ids).size, ids.length);
});

test("getNeed: lookup by id", () => {
	assert.equal(getNeed("tools_wood").level, 2);
	assert.equal(getNeed("doesnt-exist"), null);
});

test("L0 alive: full HP and food → satisfied", () => {
	const n = getNeed("alive");
	assert.equal(n.detect(snap()), true);
	assert.equal(n.pursue(snap()), null);
});

test("L0 alive: low HP with close hostile → flee", () => {
	const n = getNeed("alive");
	const s = snap({ health: 4, closestHostile: { name: "zombie", distance: 3 } });
	assert.equal(n.detect(s), false);
	assert.equal(n.pursue(s).skillId, "survive.flee");
});

test("L0 alive: zero food and have food → eat", () => {
	const n = getNeed("alive");
	const s = snap({ food: 0, hasFood: true, inventory: { bread: 3 } });
	assert.equal(n.detect(s), false);
	assert.equal(n.pursue(s).skillId, "survive.eat");
});

test("L0 alive: zero food and no food → acquire", () => {
	const n = getNeed("alive");
	const s = snap({ food: 0, hasFood: false });
	assert.equal(n.detect(s), false);
	assert.equal(n.pursue(s).skillId, "survive.acquire-food");
});

test("L1 food: 6+ food items → satisfied", () => {
	const n = getNeed("food");
	assert.equal(n.detect(snap({ food: 10, inventory: { bread: 6 } })), true);
	assert.equal(n.detect(snap({ food: 10, inventory: { bread: 3 } })), false);
});

test("L1 food: full saturation + any food → satisfied (no panic gathering)", () => {
	const n = getNeed("food");
	// food=20 means belly is full; 3 bread is enough until we get hungry again
	assert.equal(n.detect(snap({ food: 20, inventory: { bread: 3 } })), true);
});

test("L2 tools_wood: starts with no logs → gather.logs", () => {
	const n = getNeed("tools_wood");
	const s = snap();
	assert.equal(n.detect(s), false);
	assert.equal(n.pursue(s).skillId, "gather.logs");
});

test("L2 tools_wood: has logs but no planks → craft.planks", () => {
	const n = getNeed("tools_wood");
	const s = snap({ inventory: { oak_log: 3 } });
	assert.equal(n.pursue(s).skillId, "craft.planks");
});

test("L2 tools_wood: progression to pickaxe → axe → sword", () => {
	const n = getNeed("tools_wood");
	// has planks + sticks but no pickaxe
	let s = snap({ inventory: { oak_planks: 8, stick: 4 } });
	assert.equal(n.pursue(s).skillId, "craft.wooden-pickaxe");
	// has pickaxe but no axe
	s = snap({ inventory: { oak_planks: 8, stick: 4, wooden_pickaxe: 1 } });
	assert.equal(n.pursue(s).skillId, "craft.wooden-axe");
	// pickaxe + axe but no sword
	s = snap({ inventory: { oak_planks: 8, stick: 4, wooden_pickaxe: 1, wooden_axe: 1 } });
	assert.equal(n.pursue(s).skillId, "craft.wooden-sword");
	// all three
	s = snap({ inventory: { wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1 } });
	assert.equal(n.detect(s), true);
});

test("L3 shelter_basic: bed nearby → satisfied", () => {
	const n = getNeed("shelter_basic");
	assert.equal(n.detect(snap({ nearbyBlocks: { beds: 1 } })), true);
	assert.equal(n.detect(snap({ inventory: { red_bed: 1 } })), true);
	assert.equal(n.detect(snap()), false);
});

test("L3 shelter_basic: no wool → gather.wool", () => {
	const n = getNeed("shelter_basic");
	const s = snap({ inventory: { oak_planks: 3 } });
	assert.equal(n.pursue(s).skillId, "gather.wool");
});

test("L3 shelter_basic: enough wool + planks → craft.bed", () => {
	const n = getNeed("shelter_basic");
	const s = snap({ inventory: { white_wool: 3, oak_planks: 3 } });
	assert.equal(n.pursue(s).skillId, "craft.bed");
});

test("L4 tools_stone: needs cobblestone first", () => {
	const n = getNeed("tools_stone");
	const s = snap({ inventory: { wooden_pickaxe: 1 } });
	assert.equal(n.detect(s), false);
	assert.equal(n.pursue(s).skillId, "gather.stone");
});

test("L4 tools_stone: cobble + sticks → craft.stone-pickaxe", () => {
	const n = getNeed("tools_stone");
	const s = snap({ inventory: { cobblestone: 6, stick: 4 } });
	assert.equal(n.pursue(s).skillId, "craft.stone-pickaxe");
});

test("L5 armor_basic: torso equipped → satisfied", () => {
	const n = getNeed("armor_basic");
	const s = snap({ equipment: { torso: "leather_chestplate" } });
	assert.equal(n.detect(s), true);
});

test("L5 armor_basic: no craft skill yet → pursue returns null", () => {
	const n = getNeed("armor_basic");
	const s = snap();
	assert.equal(n.detect(s), false);
	assert.equal(n.pursue(s), null);
});

test("L6 food_security: ≥16 food → satisfied", () => {
	const n = getNeed("food_security");
	assert.equal(n.detect(snap({ inventory: { bread: 16 } })), true);
	assert.equal(n.detect(snap({ inventory: { bread: 10 } })), false);
});

test("L7 tools_iron: always pursues gather.stone (no craft.iron-* yet)", () => {
	const n = getNeed("tools_iron");
	const s = snap();
	assert.equal(n.detect(s), false);
	assert.equal(n.pursue(s).skillId, "gather.stone");
});

test("L8 armor_iron: iron_chestplate equipped → satisfied", () => {
	const n = getNeed("armor_iron");
	assert.equal(n.detect(snap({ equipment: { torso: "iron_chestplate" } })), true);
	assert.equal(n.detect(snap({ equipment: { torso: "leather_chestplate" } })), false);
});

test("L9 village_seed: bed + storage nearby → satisfied", () => {
	const n = getNeed("village_seed");
	assert.equal(n.detect(snap({ nearbyBlocks: { beds: 1, storage: 1 } })), true);
});

test("L9 village_seed: no chest → craft.chest if enough planks", () => {
	const n = getNeed("village_seed");
	const s = snap({ inventory: { oak_planks: 10 } });
	assert.equal(n.pursue(s).skillId, "craft.chest");
});

test("L10 village_full: never satisfied (global goal)", () => {
	const n = getNeed("village_full");
	assert.equal(n.detect(snap()), false);
	assert.equal(n.pursue(snap()), null);
});

test("helpers: hasAny / countAny work over inventory", () => {
	const { hasAny, countAny } = __testing;
	const inv = { bread: 3, cooked_beef: 1 };
	assert.equal(hasAny(inv, ["bread", "apple"]), true);
	assert.equal(hasAny(inv, ["apple"]), false);
	assert.equal(countAny(inv, ["bread", "cooked_beef"]), 4);
});

test("helpers: countLogs / countPlanks sum across variants", () => {
	const { countLogs, countPlanks } = __testing;
	assert.equal(countLogs({ oak_log: 3, birch_log: 2, dirt: 5 }), 5);
	assert.equal(countPlanks({ oak_planks: 4, birch_planks: 2 }), 6);
});
