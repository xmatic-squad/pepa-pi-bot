import { test } from "node:test";
import assert from "node:assert/strict";

import { prerequisitesMet, canRun, runnableFrontier, _internal } from "./skill-graph.js";

function world(inv = {}) {
	return { inventory: inv };
}

test("gather.logs needs nothing", () => {
	assert.equal(canRun("gather.logs", world()), true);
});

test("gather.stone needs a pickaxe (any tier)", () => {
	assert.equal(canRun("gather.stone", world({})), false);
	assert.equal(canRun("gather.stone", world({ wooden_pickaxe: 1 })), true);
	assert.equal(canRun("gather.stone", world({ stone_pickaxe: 1 })), true);
});

test("craft.planks needs a log (semantic group)", () => {
	assert.equal(canRun("craft.planks", world({})), false);
	assert.equal(canRun("craft.planks", world({ birch_log: 1 })), true);
	assert.equal(canRun("craft.planks", world({ mangrove_stem: 2 })), true);
});

test("craft.furnace needs 8 cobblestone", () => {
	assert.equal(canRun("craft.furnace", world({ cobblestone: 7 })), false);
	assert.equal(canRun("craft.furnace", world({ cobblestone: 8 })), true);
	assert.equal(canRun("craft.furnace", world({ cobbled_deepslate: 8 })), true);
});

test("prerequisitesMet reports the missing requirement detail", () => {
	const r = prerequisitesMet("craft.wooden-pickaxe", world({ stick: 2 }));
	assert.equal(r.ok, false);
	assert.deepEqual(r.missing, [{ item: "planks", min: 3, have: 0 }]);
});

test("unknown skill is treated as runnable (known:false)", () => {
	const r = prerequisitesMet("explore.far", world());
	assert.equal(r.ok, true);
	assert.equal(r.known, false);
});

test("axe matcher excludes pickaxe", () => {
	assert.equal(_internal.TOOL.axe("wooden_axe"), true);
	assert.equal(_internal.TOOL.axe("wooden_pickaxe"), false);
	assert.equal(_internal.TOOL.pickaxe("stone_pickaxe"), true);
});

test("runnableFrontier grows as inventory fills", () => {
	const empty = runnableFrontier(world());
	const stocked = runnableFrontier(world({ oak_planks: 8, stick: 4, cobblestone: 8, wooden_pickaxe: 1 }));
	assert.ok(stocked.length > empty.length);
	assert.ok(stocked.includes("gather.stone"));
	assert.ok(stocked.includes("craft.furnace"));
});
