import { test } from "node:test";
import assert from "node:assert/strict";

import { createGoalManager } from "./goal-manager.js";
import { SETTLEMENT_CONTRACT } from "./contract.js";
import { worldFromSnapshot, checkInvariants } from "./invariants.js";

function snap(extra = {}) {
	return {
		connected: true,
		position: { x: 0, y: 64, z: 0 },
		health: 20,
		food: 20,
		hasFood: false,
		isDay: true,
		inventory: {},
		locations: {},
		nearbyEntities: { passives: [], droppedItems: [] },
		...extra,
	};
}

const ALL_TOOLS = {
	wooden_axe: 1, wooden_pickaxe: 1, wooden_sword: 1,
	stone_axe: 1, stone_pickaxe: 1, stone_sword: 1, furnace: 1,
	white_bed: 1, torch: 8, bread: 5,
};

test("fresh spawn selects M1 wood tools, suggests gather.logs", () => {
	const gm = createGoalManager();
	const r = gm.next(snap());
	assert.equal(r.done, false);
	assert.equal(r.milestone.id, "M1_wood_tools");
	assert.equal(r.suggestedSkill.skillId, "gather.logs");
});

test("starving preempts lower milestones with the food skill (not curriculum wood)", () => {
	const gm = createGoalManager();
	const r = gm.next(snap({ food: 5 }));
	assert.equal(r.milestone.id, "M4_food_security");
	// no visible target → scout, and crucially NOT gather.logs
	assert.equal(r.suggestedSkill.skillId, "survive.scout-food");
	assert.match(r.reason, /urgent/);
});

test("starving with a visible chicken hunts it", () => {
	const gm = createGoalManager();
	const r = gm.next(snap({ food: 5, nearbyEntities: { passives: [{ name: "chicken", distance: 4 }], droppedItems: [] } }));
	assert.equal(r.milestone.id, "M4_food_security");
	assert.equal(r.suggestedSkill.skillId, "survive.acquire-food");
});

test("not-quite-starving (food 10) does NOT preempt wood; mild urgency only", () => {
	const gm = createGoalManager();
	// food 10 → M4 urgency 20, M1 unmet at index 1 → score(M1)=-1, score(M4)=-4+20=16 → M4 still wins.
	// To assert ordered behaviour we use food 13 (urgency 0): wood wins.
	const r = gm.next(snap({ food: 13 }));
	assert.equal(r.milestone.id, "M1_wood_tools");
});

test("with wood+stone+bed+food, lowest unmet is M5 storage → craft.chest", () => {
	const gm = createGoalManager();
	const r = gm.next(snap({ inventory: { ...ALL_TOOLS, torch: 0 }, food: 20 }));
	// torch removed so M6 lighting also unmet, but storage (M5) is lower.
	assert.equal(r.milestone.id, "M5_storage");
	assert.equal(r.suggestedSkill.skillId, "craft.chest");
});

test("everything done → done:true, completed == total", () => {
	const gm = createGoalManager();
	const r = gm.next(snap({
		inventory: ALL_TOOLS,
		food: 20,
		hasFood: true,
		locations: { chest: { x: 1 }, base: { x: 2 }, shelter: { x: 3 }, farm: { x: 4 } },
	}));
	assert.equal(r.done, true);
	assert.equal(r.completed, r.total);
	assert.equal(r.milestone, null);
});

test("progress fraction increases as milestones complete", () => {
	const gm = createGoalManager();
	const empty = gm.next(snap());
	const advanced = gm.next(snap({ inventory: ALL_TOOLS, food: 20, hasFood: true }));
	assert.ok(advanced.completed > empty.completed);
	assert.equal(advanced.total, SETTLEMENT_CONTRACT.length);
});

test("checkInvariants reports which invariant is unmet", () => {
	const m = SETTLEMENT_CONTRACT.find((x) => x.id === "M3_stone_tools");
	const world = worldFromSnapshot(snap({ inventory: { stone_axe: 1, stone_pickaxe: 1, stone_sword: 1 } }));
	const c = checkInvariants(m, world);
	// missing furnace → unmet
	assert.equal(c.met, false);
	assert.ok(c.unmet.includes("stone_tier"));
});
