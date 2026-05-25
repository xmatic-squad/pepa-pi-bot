// Tests for runtime/skills/groups.js. We synthesise fake registries that
// stand in for what mineflayer ships via bot.registry — small enough to be
// hand-tested across "modern" and "old" Minecraft shapes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { logs, planks, sticks, beds, foods, axes, pickaxes, swords } from "./groups.js";

function makeBot({ items = [], blocks = [] } = {}) {
	const itemsByName = Object.fromEntries(items.map((name) => [name, { id: 1, name }]));
	const blocksByName = Object.fromEntries(blocks.map((name) => [name, { id: 1, name }]));
	return { registry: { itemsByName, blocksByName } };
}

test("logs() picks every _log and _stem block from registry", () => {
	const bot = makeBot({
		blocks: ["oak_log", "dark_oak_log", "crimson_stem", "warped_stem", "stone", "dirt"],
	});
	const got = logs(bot);
	assert.deepEqual(
		Array.from(got).sort(),
		["crimson_stem", "dark_oak_log", "oak_log", "warped_stem"],
	);
});

test("logs() returns empty when registry missing", () => {
	assert.equal(logs(null).size, 0);
	assert.equal(logs({}).size, 0);
	assert.equal(logs({ registry: {} }).size, 0);
});

test("planks/sticks/beds match by suffix or exact name", () => {
	const bot = makeBot({
		items: ["oak_planks", "stick", "dirt"],
		blocks: ["red_bed", "white_bed", "stone"],
	});
	assert.deepEqual(Array.from(planks(bot)).sort(), ["oak_planks"]);
	assert.deepEqual(Array.from(sticks(bot)), ["stick"]);
	assert.deepEqual(Array.from(beds(bot)).sort(), ["red_bed", "white_bed"]);
});

test("foods() intersects the allowlist with the registry", () => {
	const bot = makeBot({
		items: ["bread", "apple", "spider_eye", "rotten_flesh", "cooked_beef", "glow_berries"],
	});
	const got = foods(bot);
	// Allowlist members present in this registry only — spider_eye and
	// rotten_flesh are explicitly NOT in the allowlist and must be excluded.
	assert.deepEqual(
		Array.from(got).sort(),
		["apple", "bread", "cooked_beef", "glow_berries"],
	);
});

test("foods() returns empty on missing registry", () => {
	assert.equal(foods(null).size, 0);
});

test("axes/pickaxes/swords scoped to what the version actually ships", () => {
	const bot = makeBot({
		items: ["wooden_axe", "stone_axe", "iron_pickaxe", "diamond_sword"],
	});
	assert.deepEqual(Array.from(axes(bot)).sort(), ["stone_axe", "wooden_axe"]);
	assert.deepEqual(Array.from(pickaxes(bot)).sort(), ["iron_pickaxe"]);
	assert.deepEqual(Array.from(swords(bot)).sort(), ["diamond_sword"]);
});
