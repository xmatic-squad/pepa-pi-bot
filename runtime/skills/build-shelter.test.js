// build-shelter closed-loop integrity: the shelter LOCATION (which satisfies
// M8_shelter's locationExists("shelter") invariant) must be recorded ONLY when
// the build actually made progress. A build that places nothing and skips
// nothing must NOT mark M8 done. Runs against the isolated test state dir
// (config.js detects --test), with a fake bot carrying a real minecraft-data
// registry so applyProfile/Movements construct without a live server.

import { test } from "node:test";
import assert from "node:assert/strict";
import mcDataLoader from "minecraft-data";

import { skill } from "./build-shelter.js";
import { setLocation, getLocation, removeLocation } from "../locations.js";

const registry = mcDataLoader("1.21.4");

function makePos(x, y, z) {
	return { x, y, z, clone: () => makePos(x, y, z), offset: (dx, dy, dz) => makePos(x + dx, y + dy, z + dz) };
}

// blockKind: (target) => block-or-null describing what bot.blockAt returns at
// every coordinate. We use it to make the whole world either air (no
// placement possible) or solid (every placement succeeds).
function makeBot(blockKind, planks = 30) {
	return {
		registry,
		world: {},
		entity: { position: makePos(0, 64, 0) },
		pathfinder: { setMovements() {} },
		inventory: { items: () => (planks > 0 ? [{ name: "oak_planks", count: planks }] : []) },
		blockAt(p) { return blockKind(p); },
		async equip() { return true; },
		async placeBlock() { return true; },
	};
}

test("failed build (placed 0, skipped 0) does NOT record a shelter location", async () => {
	removeLocation("shelter");
	setLocation("base", { x: 0, y: 64, z: 0, note: "test base" });

	// Air everywhere → every findReferenceForPlacement returns null → nothing
	// placed, nothing skipped.
	const bot = makeBot(() => ({ name: "air", boundingBox: "empty" }));
	const res = await skill.execute({ bot, owned: null });

	assert.equal(res.ok, false);
	assert.equal(res.code, "no_progress");
	assert.equal(getLocation("shelter"), null, "shelter location must NOT be recorded on a no-progress build");

	removeLocation("base");
});

test("successful build records the shelter location", async () => {
	removeLocation("shelter");
	setLocation("base", { x: 0, y: 64, z: 0, note: "test base" });

	// Solid everywhere → every target has a reference block to place against.
	const bot = makeBot((p) => ({ name: "stone", boundingBox: "block", position: makePos(p.x, p.y, p.z) }));
	const res = await skill.execute({ bot, owned: null });

	assert.equal(res.ok, true);
	assert.equal(res.code, "done");
	assert.ok(res.detail.placed > 0, "expected at least one block placed");
	const shelter = getLocation("shelter");
	assert.ok(shelter && shelter.x === 0 && shelter.z === 0, "shelter location recorded on success");

	removeLocation("shelter");
	removeLocation("base");
});
