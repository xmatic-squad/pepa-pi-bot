import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreSite } from "./base-site.js";

function block(name, x, z, y = 64, distance = null) {
	return {
		name,
		position: { x, y, z },
		distance: distance ?? Math.hypot(x, z),
	};
}

test("scoreSite: empty surroundings → near-floor score", () => {
	const out = scoreSite({
		blocks: [],
		surfaceYs: [64, 64, 64, 64, 64],
		players: [],
		position: { x: 0, y: 64, z: 0 },
	});
	// no wood -0, no stone -0, no water -0, flat +2, no players +2,
	// no foreign builds +3 → 7
	assert.equal(out.score, 7);
});

test("scoreSite: wood + stone + water + flat + no players + no claims → high", () => {
	const out = scoreSite({
		blocks: [
			block("oak_log", 5, 5),
			block("stone", 4, 0),
			block("water", 10, 0),
		],
		surfaceYs: [64, 64, 64, 64, 64],
		players: [],
		position: { x: 0, y: 64, z: 0 },
	});
	// wood +3, stone +2, water +2, flat +2, no players +2, no claims +3 → 14
	assert.equal(out.score, 14);
});

test("scoreSite: foreign build subtracts heavily", () => {
	const out = scoreSite({
		blocks: [
			block("oak_log", 5, 5),
			block("oak_planks", 6, 0), // man-made, not owned
		],
		surfaceYs: [64, 64, 64, 64, 64],
		players: [],
		position: { x: 0, y: 64, z: 0 },
		isOwned: () => false,
	});
	// wood +3, no stone 0, no water 0, flat +2, no players +2, foreign -10 → -3
	assert.equal(out.score, -3);
});

test("scoreSite: bot-owned man-made blocks don't penalise", () => {
	const out = scoreSite({
		blocks: [
			block("oak_log", 5, 5),
			block("crafting_table", 2, 0),
		],
		surfaceYs: [64, 64, 64, 64, 64],
		players: [],
		position: { x: 0, y: 64, z: 0 },
		isOwned: () => true,
	});
	// wood +3, flat +2, no players +2, no foreign +3 → 10
	assert.equal(out.score, 10);
});

test("scoreSite: bumpy surface loses the flatness +2", () => {
	const out = scoreSite({
		blocks: [],
		surfaceYs: [60, 64, 64, 68, 65],
		players: [],
		position: { x: 0, y: 64, z: 0 },
	});
	// flat 0, no players +2, no foreign +3 → 5
	assert.equal(out.score, 5);
});

test("scoreSite: nearby player loses the +2", () => {
	const out = scoreSite({
		blocks: [],
		surfaceYs: [64, 64, 64, 64, 64],
		players: [{ distance: 10 }],
		position: { x: 0, y: 64, z: 0 },
	});
	// flat +2, players 0, no foreign +3 → 5
	assert.equal(out.score, 5);
});
