// Invariant predicate library — these are the "milestone done" truths the
// Settlement Contract relies on. Locking them guards against the closed-loop
// regressions the v0.4.1 audit surfaced (e.g. M2_bed must be able to close via
// a recorded bed LOCATION once actions.js writes locations.bed, not only via a
// transient carried-bed item).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	worldFromSnapshot,
	bedSecured,
	foodSecure,
	stoneTier,
	locationExists,
	hasItem,
} from "./invariants.js";

const w = (snap) => worldFromSnapshot(snap);

test("bedSecured: met by a carried bed item", () => {
	assert.equal(bedSecured().met(w({ inventory: { red_bed: 1 } })), true);
});

test("bedSecured: met by a recorded bed LOCATION (M2 monotonicity after the bed is placed)", () => {
	// The carried item is gone (consumed by placement) but the location was
	// recorded — M2 must stay satisfied so the contract doesn't loop
	// gather.wool→craft.bed for a bed that physically exists.
	assert.equal(bedSecured().met(w({ inventory: {}, locations: { bed: { x: 1, y: 64, z: 1 } } })), true);
});

test("bedSecured: unmet with neither a bed item nor a bed location", () => {
	assert.equal(bedSecured().met(w({ inventory: {}, locations: {} })), false);
});

test("foodSecure: cooked staple, well-fed, or hasFood — but not raw materials", () => {
	assert.equal(foodSecure().met(w({ inventory: { bread: 1 } })), true);
	assert.equal(foodSecure().met(w({ inventory: {}, food: 18 })), true);
	assert.equal(foodSecure().met(w({ inventory: {}, hasFood: true })), true);
	assert.equal(foodSecure().met(w({ inventory: { cobblestone: 40 }, food: 10 })), false);
});

test("stoneTier: needs all three stone tools AND a furnace", () => {
	assert.equal(stoneTier().met(w({ inventory: { stone_axe: 1, stone_pickaxe: 1, stone_sword: 1 } })), false);
	assert.equal(stoneTier().met(w({ inventory: { stone_axe: 1, stone_pickaxe: 1, stone_sword: 1, furnace: 1 } })), true);
});

test("locationExists: pure key-presence over locations (no item required)", () => {
	assert.equal(locationExists("shelter").met(w({ locations: { shelter: { x: 0, y: 64, z: 0 } } })), true);
	assert.equal(locationExists("shelter").met(w({ locations: {} })), false);
});

test("hasItem('torch', 4): the M6 lighting threshold", () => {
	assert.equal(hasItem("torch", 4, "torch").met(w({ inventory: { torch: 3 } })), false);
	assert.equal(hasItem("torch", 4, "torch").met(w({ inventory: { torch: 4 } })), true);
});
