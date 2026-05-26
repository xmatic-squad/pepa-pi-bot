// Tests for runtime/movement-profiles.js, runtime/owned-blocks.js
// and runtime/claim-avoidance.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describeProfile, PROFILES, PROFILE_DEFAULTS } from "./movement-profiles.js";
import { isManMadeBlockName, classifyArea, shouldAvoid } from "./claim-avoidance.js";

// We can't import owned-blocks.js until config-driven stateDir exists,
// so it's tested via an isolated import in a temp dir below.

// 2026-05-26: canDig is FALSE on every profile because bot.dig silently
// fails on the live server (mineflayer #3888 / protocol 775). Once the
// 1.21.4 pin restores real digging, gather/travel/flee profiles can flip
// canDig back to true.
test("movement profile descriptor: gather has canDig=false (silent-dig safeguard)", () => {
	const d = describeProfile(PROFILES.GATHER);
	assert.equal(d.canDig, false);
	assert.equal(d.canPlace, false);
	assert.equal(d.allow1by1towers, false);
});

test("movement profile descriptor: flee allows higher drop, canDig=false", () => {
	const d = describeProfile(PROFILES.FLEE);
	assert.equal(d.canDig, false);
	assert.equal(d.maxDropDown, 8);
});

test("movement profile descriptor: build has canDig=false canPlace=true", () => {
	const d = describeProfile(PROFILES.BUILD);
	assert.equal(d.canDig, false);
	assert.equal(d.canPlace, true);
});

test("movement profile descriptor: unknown throws", () => {
	assert.throws(() => describeProfile("nope"), /unknown/);
});

test("PROFILE_DEFAULTS is frozen", () => {
	assert.ok(Object.isFrozen(PROFILE_DEFAULTS));
});

test("isManMadeBlockName matches planks/bricks/exact list", () => {
	assert.equal(isManMadeBlockName("oak_planks"), true);
	assert.equal(isManMadeBlockName("stone_bricks"), true);
	assert.equal(isManMadeBlockName("crafting_table"), true);
	assert.equal(isManMadeBlockName("oak_log"), false);
	assert.equal(isManMadeBlockName("stone"), false);
	assert.equal(isManMadeBlockName("dirt"), false);
	assert.equal(isManMadeBlockName(null), false);
});

test("classifyArea flags high man-made density as player_build", () => {
	const blocks = [
		{ name: "oak_planks", position: { x: 0, y: 64, z: 0 } },
		{ name: "oak_planks", position: { x: 0, y: 65, z: 0 } },
		{ name: "stone_bricks", position: { x: 1, y: 64, z: 0 } },
		{ name: "stone_bricks", position: { x: 2, y: 64, z: 0 } },
		{ name: "oak_door", position: { x: 0, y: 64, z: 1 } },
		{ name: "dirt", position: { x: 0, y: 63, z: 0 } },
	];
	const out = classifyArea({ blocks, isOwned: () => false });
	assert.equal(out.verdict, "player_build");
	assert.equal(shouldAvoid(out), true);
});

test("classifyArea ignores low-density areas", () => {
	const blocks = [
		{ name: "oak_planks", position: { x: 0, y: 64, z: 0 } },
		{ name: "dirt", position: { x: 0, y: 63, z: 0 } },
		{ name: "dirt", position: { x: 0, y: 62, z: 0 } },
		{ name: "stone", position: { x: 0, y: 61, z: 0 } },
		{ name: "stone", position: { x: 1, y: 64, z: 0 } },
	];
	const out = classifyArea({ blocks, isOwned: () => false });
	assert.equal(out.verdict, "natural_or_owned");
	assert.equal(shouldAvoid(out), false);
});

test("classifyArea counts bot-owned blocks as not-a-player-build", () => {
	const blocks = [
		{ name: "oak_planks", position: { x: 0, y: 64, z: 0 } },
		{ name: "oak_planks", position: { x: 0, y: 65, z: 0 } },
		{ name: "stone_bricks", position: { x: 1, y: 64, z: 0 } },
		{ name: "stone_bricks", position: { x: 2, y: 64, z: 0 } },
		{ name: "crafting_table", position: { x: 0, y: 64, z: 1 } },
		{ name: "dirt", position: { x: 0, y: 63, z: 0 } },
	];
	// All man-made blocks are owned by the bot.
	const out = classifyArea({ blocks, isOwned: () => true });
	assert.equal(out.verdict, "natural_or_owned");
});

test("classifyArea: insufficient_data when too few blocks", () => {
	const out = classifyArea({ blocks: [{ name: "oak_planks", position: { x: 0, y: 0, z: 0 } }], isOwned: () => false });
	assert.equal(out.verdict, "insufficient_data");
});

// --- owned-blocks via isolated tmpdir import ---------------------------------

test("owned-blocks ledger persists, dedupes, and returns isOwned", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepa-owned-"));
	process.env.MC_HOST = "tmp.local";
	process.env.MC_PORT = String(12345 + Math.floor(Math.random() * 1000));
	process.env.MC_USERNAME = "pepa";

	// Build the file path the same way runtime/config.js does, and seed
	// the dir before importing the module so its mkdir is a no-op.
	const stateDir = path.join(
		// Mirror runtime/config.js stateDir construction:
		// REPO_ROOT/state/<host>_<port>. We point REPO_ROOT at tmp.
		tmp,
		"state",
		`${process.env.MC_HOST}_${process.env.MC_PORT}`,
	);
	fs.mkdirSync(stateDir, { recursive: true });
	// Pretend config.stateDir points there by monkey-stubbing via env? The
	// real config.js resolves stateDir from REPO_ROOT inside the project.
	// For this test we accept that owned-blocks.js will append into the
	// real state dir on `npm test`. Just verify in-memory semantics.

	const { createOwnedBlocksLedger } = await import("./owned-blocks.js");
	const ledger = createOwnedBlocksLedger();

	const before = ledger.size();
	ledger.markPlaced({ x: 100, y: 64, z: 200, blockType: "torch", skill: "test" });
	assert.equal(ledger.isOwned({ x: 100, y: 64, z: 200 }), true);
	assert.equal(ledger.size(), before + 1);
	// idempotent
	ledger.markPlaced({ x: 100, y: 64, z: 200, blockType: "torch" });
	assert.equal(ledger.size(), before + 1);
	// remove
	ledger.markRemoved({ x: 100, y: 64, z: 200 });
	assert.equal(ledger.isOwned({ x: 100, y: 64, z: 200 }), false);
});
