import { test } from "node:test";
import assert from "node:assert/strict";

import {
	observe,
	isWedged,
	markRelocationStarted,
	activeRelocation,
	_resetForTest,
	__testing,
} from "./wedge-detector.js";

const { WINDOW_MS, MIN_BBOX_FOR_WEDGE, MIN_UNMET_NEED_MS, MIN_SKILL_CYCLES, countCycles } = __testing;

test("countCycles: empty / short → 0", () => {
	assert.equal(countCycles([]), 0);
	assert.equal(countCycles(["a"]), 0);
	assert.equal(countCycles(["a", "b"]), 0);
});

test("countCycles: A→B→A counts as cycle", () => {
	assert.equal(countCycles(["a", "b", "a"]), 1);
	assert.equal(countCycles(["a", "b", "a", "b", "a"]), 3);
});

test("countCycles: same skill 3+ times in a row also counts", () => {
	assert.equal(countCycles(["a", "a", "a"]), 1);
	assert.equal(countCycles(["a", "a", "a", "a"]), 2);
});

test("isWedged: insufficient samples → not wedged", () => {
	_resetForTest();
	const r = isWedged({ activeNeedId: "food" });
	assert.equal(r.wedged, false);
	assert.equal(r.reason, "insufficient_samples");
});

test("isWedged: large bbox → not wedged", () => {
	_resetForTest();
	const t0 = 1_000_000_000_000;
	// scatter across 200 blocks
	for (let i = 0; i < 12; i++) {
		observe({ x: i * 30, z: i * 25, now: t0 + i * 1000, activeNeedId: "food", recentSkillIds: [] });
	}
	const r = isWedged({ activeNeedId: "food", recentSkillIds: ["a", "b", "a", "b"], now: t0 + 13_000 });
	assert.equal(r.wedged, false);
	assert.equal(r.reason, "bbox_ok");
});

test("isWedged: tight bbox + old need + cycles → WEDGED", () => {
	_resetForTest();
	const t0 = 1_000_000_000_000;
	// 12 samples within a 30-block bbox, spread across ~9 min so they
	// stay inside the 10-min sliding window.
	for (let i = 0; i < 12; i++) {
		observe({
			x: 500 + (i % 4) * 8,
			z: 500 + Math.floor(i / 4) * 8,
			now: t0 + i * 45_000,
			activeNeedId: "food",
			recentSkillIds: ["acquire-food", "explore.far", "acquire-food", "explore.far", "acquire-food"],
		});
	}
	const r = isWedged({
		activeNeedId: "food",
		recentSkillIds: ["acquire-food", "explore.far", "acquire-food", "explore.far", "acquire-food", "explore.far"],
		now: t0 + 12 * 45_000,
	});
	assert.equal(r.wedged, true, `expected wedged, got ${JSON.stringify(r)}`);
	assert.ok(r.bboxDim < MIN_BBOX_FOR_WEDGE);
	assert.ok(r.needAgeMs >= MIN_UNMET_NEED_MS);
	assert.ok(r.skillCycles >= MIN_SKILL_CYCLES);
});

test("isWedged: recent need (under threshold) → not wedged", () => {
	_resetForTest();
	const t0 = 1_000_000_000_000;
	for (let i = 0; i < 12; i++) {
		observe({ x: 500, z: 500, now: t0 + i * 10_000, activeNeedId: "food" });
	}
	const r = isWedged({ activeNeedId: "food", recentSkillIds: ["a", "b", "a", "b"], now: t0 + 60_000 });
	assert.equal(r.wedged, false);
});

test("markRelocationStarted blocks subsequent wedge for 200b", () => {
	_resetForTest();
	const t0 = 1_000_000_000_000;
	markRelocationStarted({ x: 500, z: 500, heading: { name: "N" } });
	assert.ok(activeRelocation());
	// Stay tight bbox after relocation start
	for (let i = 0; i < 12; i++) {
		observe({ x: 510, z: 510, now: t0 + i * 60_000, activeNeedId: "food" });
	}
	const r = isWedged({ activeNeedId: "food", recentSkillIds: ["a", "b", "a", "b"] });
	assert.equal(r.wedged, false);
	assert.equal(r.reason, "relocating");
});

test("relocation clears after travelling ≥200 blocks", () => {
	_resetForTest();
	markRelocationStarted({ x: 0, z: 0, heading: { name: "N" } });
	observe({ x: 250, z: 0, activeNeedId: "food" });
	assert.equal(activeRelocation(), null, "relocation cleared after 250b displacement");
});
