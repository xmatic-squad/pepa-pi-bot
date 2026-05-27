import { test } from "node:test";
import assert from "node:assert/strict";

import {
	affordancesFor,
	hasPassiveMobs,
	hasTrees,
	hasWater,
	isLivable,
	isBarren,
	isUnlivable,
	__testing,
} from "./biome-affordances.js";

test("plains: full affordances (mobs + scattered trees)", () => {
	const a = affordancesFor("plains");
	assert.equal(a.has_passive_mobs, true);
	assert.equal(a.has_trees, true);
	assert.equal(a.livable, true);
});

test("desert: barren (no mobs, no trees, no water)", () => {
	assert.equal(hasPassiveMobs("desert"), false);
	assert.equal(hasTrees("desert"), false);
	assert.equal(hasWater("desert"), false);
	assert.equal(isBarren("desert"), true);
	assert.equal(isLivable("desert"), true, "desert is walkable, just empty");
});

test("ocean / deep_ocean: unlivable + has water", () => {
	assert.equal(isUnlivable("ocean"), true);
	assert.equal(isUnlivable("deep_ocean"), true);
	assert.equal(hasWater("ocean"), true);
	assert.equal(hasPassiveMobs("ocean"), false);
});

test("mushroom_fields: passive mobs (mooshroom) even though no other animals", () => {
	assert.equal(hasPassiveMobs("mushroom_fields"), true);
	assert.equal(isBarren("mushroom_fields"), false);
});

test("forest variants: trees + mobs", () => {
	for (const b of ["forest", "birch_forest", "dark_forest", "taiga", "snowy_taiga", "jungle", "swamp"]) {
		assert.equal(hasTrees(b), true, `${b} should have trees`);
		assert.equal(hasPassiveMobs(b), true, `${b} should have passive mobs`);
	}
});

test("badlands variants: no mobs, no trees (except wooded_badlands)", () => {
	assert.equal(hasPassiveMobs("badlands"), false);
	assert.equal(hasTrees("badlands"), false);
	assert.equal(hasTrees("wooded_badlands"), true, "wooded variant has trees");
	assert.equal(isBarren("badlands"), true);
});

test("unknown biome: optimistic defaults (don't cripple skills)", () => {
	const a = affordancesFor("not_a_real_biome_2026");
	assert.equal(a.has_passive_mobs, true);
	assert.equal(a.livable, true);
});

test("null / undefined: optimistic defaults", () => {
	assert.deepEqual(affordancesFor(null), __testing.DEFAULT);
	assert.deepEqual(affordancesFor(undefined), __testing.DEFAULT);
	assert.deepEqual(affordancesFor(42), __testing.DEFAULT);
});
