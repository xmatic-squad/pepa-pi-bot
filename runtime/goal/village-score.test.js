import { test } from "node:test";
import assert from "node:assert/strict";

import { computeVillageScore, _internal } from "./village-score.js";

function snap(extra = {}) {
	return { connected: true, health: 20, food: 20, hasFood: false, locations: {}, ...extra };
}

test("empty/fresh world scores low", () => {
	const r = computeVillageScore(snap({ health: 20, food: 5 }), {
		contract: { completed: 0, total: 10 },
		uptimeMs: 0,
		metrics: {},
	});
	assert.ok(r.score < 0.2, `expected low score, got ${r.score}`);
});

test("a fully established settlement scores high", () => {
	const metrics = {};
	for (let i = 0; i < 12; i++) metrics[`skill.${i}`] = { ok: 3, fail: 0 };
	const r = computeVillageScore(
		snap({ health: 20, food: 20, hasFood: true, locations: { base: {}, shelter: {}, chest: {} } }),
		{ contract: { completed: 10, total: 10 }, uptimeMs: 3 * 60 * 60 * 1000, metrics },
	);
	assert.ok(r.score > 0.9, `expected high score, got ${r.score}`);
	assert.equal(r.components.milestones, 1);
	assert.equal(r.components.base, 1);
});

test("score is monotonic in milestone completion", () => {
	const base = { uptimeMs: 0, metrics: {} };
	const low = computeVillageScore(snap(), { ...base, contract: { completed: 1, total: 10 } });
	const high = computeVillageScore(snap(), { ...base, contract: { completed: 8, total: 10 } });
	assert.ok(high.score > low.score);
});

test("score stays within 0..1", () => {
	const r = computeVillageScore(snap({ health: 999, food: 999 }), {
		contract: { completed: 100, total: 10 },
		uptimeMs: 1e12,
		metrics: { a: { ok: 999 } },
	});
	assert.ok(r.score >= 0 && r.score <= 1);
});

test("clamp01 helper", () => {
	assert.equal(_internal.clamp01(-1), 0);
	assert.equal(_internal.clamp01(2), 1);
	assert.equal(_internal.clamp01(0.5), 0.5);
	assert.equal(_internal.clamp01(NaN), 0);
});
