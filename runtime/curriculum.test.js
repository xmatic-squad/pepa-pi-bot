// Tests for runtime/curriculum.js. The chooser is pure, so we just feed
// snapshots and assert which milestone + skill comes back.

import { test } from "node:test";
import assert from "node:assert/strict";

import { nextMilestone, isInventoryFull, listMilestones } from "./curriculum.js";

function snap(inventory, extras = {}) {
	return { connected: true, inventory, ...extras };
}

// A baseline of "everything before this stage is already done". Callers pass
// the extra items needed to exercise the milestone under test, so individual
// tests stay tiny and focused.
function snapAfter(stage, addInventory = {}, extras = {}) {
	const baseline = {};
	const layers = {
		"wood.16": { oak_log: 16 },
		"wood.planks-and-sticks": { oak_log: 16, oak_planks: 4, stick: 4 },
		"wood.tools": {
			oak_log: 16, oak_planks: 6, stick: 6,
			wooden_axe: 1, wooden_pickaxe: 1, wooden_sword: 1,
		},
		// New: survive.bed sits between wood.tools and stone.32, so every
		// later-stage baseline carries a red_bed in inventory to mark the
		// bed milestone as done.
		"survive.bed": {
			oak_log: 16, oak_planks: 6, stick: 6,
			wooden_axe: 1, wooden_pickaxe: 1, wooden_sword: 1,
			red_bed: 1,
		},
		"stone.32": {
			oak_log: 16, oak_planks: 6, stick: 6,
			wooden_axe: 1, wooden_pickaxe: 1, wooden_sword: 1,
			red_bed: 1,
			cobblestone: 32,
		},
		"stone.tools": {
			oak_log: 16, oak_planks: 6, stick: 8,
			wooden_axe: 1, wooden_pickaxe: 1, wooden_sword: 1,
			red_bed: 1,
			cobblestone: 8,
			stone_axe: 1, stone_pickaxe: 1, stone_sword: 1, furnace: 1,
		},
		"food.basic": {
			oak_log: 16, oak_planks: 6, stick: 8,
			wooden_axe: 1, wooden_pickaxe: 1, wooden_sword: 1,
			red_bed: 1,
			cobblestone: 8,
			stone_axe: 1, stone_pickaxe: 1, stone_sword: 1, furnace: 1,
			bread: 4,
		},
		"storage.chest": {
			oak_log: 16, oak_planks: 6, stick: 8,
			wooden_axe: 1, wooden_pickaxe: 1, wooden_sword: 1,
			red_bed: 1,
			cobblestone: 8,
			stone_axe: 1, stone_pickaxe: 1, stone_sword: 1, furnace: 1,
			bread: 4, chest: 1,
		},
	};
	Object.assign(baseline, layers[stage] ?? {}, addInventory);
	return snap(baseline, extras);
}

test("empty inventory → first milestone is wood.16, suggests gather.logs", () => {
	const got = nextMilestone(snap({}));
	assert.equal(got.milestone.id, "wood.16");
	assert.equal(got.plan.skillId, "gather.logs");
	assert.equal(got.inventoryFull, false);
});

test("with 16 logs but no planks → wood.planks-and-sticks, craft.planks first", () => {
	const got = nextMilestone(snap({ oak_log: 16 }));
	assert.equal(got.milestone.id, "wood.planks-and-sticks");
	assert.equal(got.plan.skillId, "craft.planks");
});

test("planks present but no sticks → craft.sticks", () => {
	const got = nextMilestone(snapAfter("wood.16", { oak_planks: 4 }));
	assert.equal(got.milestone.id, "wood.planks-and-sticks");
	assert.equal(got.plan.skillId, "craft.sticks");
});

test("planks+sticks but no wooden tools → wood.tools, axe first", () => {
	const got = nextMilestone(snapAfter("wood.planks-and-sticks"));
	assert.equal(got.milestone.id, "wood.tools");
	assert.equal(got.plan.skillId, "craft.wooden-axe");
});

test("wooden axe present, pickaxe missing → craft.wooden-pickaxe", () => {
	const got = nextMilestone(snapAfter("wood.planks-and-sticks", { wooden_axe: 1 }));
	assert.equal(got.milestone.id, "wood.tools");
	assert.equal(got.plan.skillId, "craft.wooden-pickaxe");
});

// After wood tools the curriculum first asks for a bed (survive.bed,
// new 2026-05-26) — we need a bed before stone-tier so the bot can
// sleep through the night and stop blocking other players.
test("wooden tools done, no bed → survive.bed, suggests gather.wool", () => {
	const got = nextMilestone(snapAfter("wood.tools"));
	assert.equal(got.milestone.id, "survive.bed");
	assert.equal(got.plan.skillId, "gather.wool");
});

test("wool ready but no bed → survive.bed, suggests craft.bed", () => {
	const got = nextMilestone(snapAfter("wood.tools", { red_wool: 3 }));
	assert.equal(got.milestone.id, "survive.bed");
	assert.equal(got.plan.skillId, "craft.bed");
});

test("bed acquired → curriculum advances to stone.32", () => {
	const got = nextMilestone(snapAfter("survive.bed"));
	assert.equal(got.milestone.id, "stone.32");
	assert.equal(got.plan.skillId, "gather.stone");
});

test("32 cobble + wooden tools → stone.tools, stone_axe first", () => {
	const got = nextMilestone(snapAfter("stone.32"));
	assert.equal(got.milestone.id, "stone.tools");
	assert.equal(got.plan.skillId, "craft.stone-axe");
});

test("stone tools present but no furnace → craft.furnace", () => {
	const got = nextMilestone(snapAfter("stone.32", {
		stone_axe: 1, stone_pickaxe: 1, stone_sword: 1,
		cobblestone: 8, // need leftover for furnace
	}));
	assert.equal(got.milestone.id, "stone.tools");
	assert.equal(got.plan.skillId, "craft.furnace");
});

test("food.basic satisfied by carrying bread", () => {
	const got = nextMilestone(snapAfter("food.basic"));
	assert.equal(got.milestone.id, "storage.chest");
});

test("food.basic satisfied by high food bar even without food item", () => {
	const got = nextMilestone(snapAfter("stone.tools", {}, { food: 20 }));
	assert.equal(got.milestone.id, "storage.chest");
});

test("all done → null", () => {
	const inv = {
		oak_log: 16, oak_planks: 8, stick: 8,
		wooden_axe: 1, wooden_pickaxe: 1, wooden_sword: 1,
		red_bed: 1,
		cobblestone: 32,
		stone_axe: 1, stone_pickaxe: 1, stone_sword: 1, furnace: 1,
		bread: 4, chest: 1, torch: 8,
	};
	assert.equal(
		nextMilestone(snap(inv, {
			food: 20,
			locations: {
				chest: { x: 1, y: 64, z: 0 },
				base: { x: 0, y: 64, z: 0 },
				shelter: { x: 0, y: 64, z: 0 },
			},
		})),
		null,
	);
});

test("isInventoryFull threshold = 32 distinct stacks", () => {
	const inv = {};
	for (let i = 0; i < 31; i++) inv[`stack_${i}`] = 1;
	assert.equal(isInventoryFull(snap(inv)), false);
	inv.stack_31 = 1;
	assert.equal(isInventoryFull(snap(inv)), true);
});

test("inventoryFull flag is returned alongside milestone, not as override", () => {
	const inv = {};
	for (let i = 0; i < 40; i++) inv[`stack_${i}`] = 1;
	const got = nextMilestone(snap(inv));
	// First milestone (wood.16) still fires; scheduler can use inventoryFull to
	// insert a deposit step.
	assert.equal(got.milestone.id, "wood.16");
	assert.equal(got.inventoryFull, true);
});

test("listMilestones exposes ordered ids for diary/TUI", () => {
	const ms = listMilestones();
	assert.equal(ms[0].id, "wood.16");
	assert.equal(ms[ms.length - 1].id, "village.shelter");
	for (const m of ms) {
		assert.equal(typeof m.id, "string");
		assert.equal(typeof m.title, "string");
	}
});

test("food.basic with no carried food or visible target suggests scout-food", () => {
	const got = nextMilestone(snapAfter("stone.tools", {}, { food: 8 }));
	assert.equal(got.milestone.id, "food.basic");
	assert.equal(got.plan.skillId, "survive.scout-food");
});

test("storage.chest crafts first, then places carried chest", () => {
	const needCraft = nextMilestone(snapAfter("food.basic", { chest: 0 }));
	assert.equal(needCraft.milestone.id, "storage.chest");
	assert.equal(needCraft.plan.skillId, "craft.chest");

	const needPlace = nextMilestone(snapAfter("food.basic", { chest: 1 }));
	assert.equal(needPlace.milestone.id, "storage.chest");
	assert.equal(needPlace.plan.skillId, "village.place-chest");
});
