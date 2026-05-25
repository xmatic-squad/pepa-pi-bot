// Compatibility tests for runtime/skills/groups.js against real
// minecraft-data registries. These don't connect to a server — they
// just instantiate the registry locally per version and assert the
// derived sets are sane.

import { test } from "node:test";
import assert from "node:assert/strict";

import mcDataFactory from "minecraft-data";
import { logs, planks, sticks, beds, foods, axes, pickaxes, swords } from "./groups.js";

const VERSIONS = ["1.18.2", "1.20.4", "1.21.5"];

function makeBotForVersion(v) {
	return { registry: mcDataFactory(v) };
}

for (const v of VERSIONS) {
	test(`groups: ${v} — logs include at least oak_log`, () => {
		const bot = makeBotForVersion(v);
		const got = logs(bot);
		assert.ok(got.has("oak_log"), `oak_log missing for ${v}`);
		assert.ok(got.size >= 4, `expected several log types for ${v}, got ${got.size}`);
	});

	test(`groups: ${v} — planks include oak_planks`, () => {
		const bot = makeBotForVersion(v);
		const got = planks(bot);
		assert.ok(got.has("oak_planks"), `oak_planks missing for ${v}`);
	});

	test(`groups: ${v} — sticks always present`, () => {
		const bot = makeBotForVersion(v);
		assert.ok(sticks(bot).has("stick"), `stick missing for ${v}`);
	});

	test(`groups: ${v} — beds non-empty`, () => {
		const bot = makeBotForVersion(v);
		assert.ok(beds(bot).size > 0, `no beds for ${v}`);
	});

	test(`groups: ${v} — foods include bread`, () => {
		const bot = makeBotForVersion(v);
		assert.ok(foods(bot).has("bread"), `bread missing for ${v}`);
	});

	test(`groups: ${v} — full pickaxe lineup`, () => {
		const bot = makeBotForVersion(v);
		const got = pickaxes(bot);
		for (const tier of ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"]) {
			assert.ok(got.has(tier), `${tier} missing for ${v}`);
		}
	});

	test(`groups: ${v} — axes and swords scoped to existing`, () => {
		const bot = makeBotForVersion(v);
		assert.ok(axes(bot).has("wooden_axe"), `wooden_axe missing for ${v}`);
		assert.ok(swords(bot).has("wooden_sword"), `wooden_sword missing for ${v}`);
	});
}

// Spot-check: pale_oak_log was added in 1.21; it must NOT appear on 1.18.
test("groups: pale_oak_log absent from 1.18.2", () => {
	const bot = makeBotForVersion("1.18.2");
	assert.ok(!logs(bot).has("pale_oak_log"), "pale_oak_log unexpectedly present on 1.18");
});
