import { test } from "node:test";
import assert from "node:assert/strict";

import { createScenarioMemory, situationHash } from "./scenario-memory.js";

function snap(extras = {}) {
	return {
		connected: true,
		position: { x: 100, y: 64, z: -200 },
		isDay: true,
		food: 18,
		health: 20,
		inventory: {},
		closestHostile: null,
		...extras,
	};
}

test("situationHash is stable for the same situation, different for different cell", () => {
	const a = situationHash(snap());
	const b = situationHash(snap());
	assert.equal(a, b);
	const c = situationHash(snap({ position: { x: 200, y: 64, z: -200 } }));
	assert.notEqual(a, c);
});

test("situationHash changes with day/night, food, health bucket, hostile", () => {
	const base = snap();
	const night = situationHash({ ...base, isDay: false });
	const lowHp = situationHash({ ...base, health: 5 });
	const hostile = situationHash({ ...base, closestHostile: { name: "zombie", distance: 5 } });
	assert.notEqual(situationHash(base), night);
	assert.notEqual(situationHash(base), lowHp);
	assert.notEqual(situationHash(base), hostile);
});

test("shouldSkip flips after N failures in the same situation", () => {
	const m = createScenarioMemory({ failureThreshold: 3, windowMs: 60_000 });
	const sit = "x|y|z|d|F|H|host:-|inv:-";
	const skillId = "test.always-fails-" + Date.now();
	assert.equal(m.shouldSkip({ skillId, situation: sit }), false);
	for (let i = 0; i < 3; i++) {
		m.record({ skillId, situation: sit, code: "no_target", ok: false, detail: "no" });
	}
	assert.equal(m.shouldSkip({ skillId, situation: sit }), true);
});

test("a recent success in the same situation un-locks the skill", () => {
	const m = createScenarioMemory({ failureThreshold: 2, windowMs: 60_000 });
	const sit = "site_alpha";
	const skillId = "test.flaky-" + Date.now();
	m.record({ skillId, situation: sit, code: "fail", ok: false });
	m.record({ skillId, situation: sit, code: "fail", ok: false });
	assert.equal(m.shouldSkip({ skillId, situation: sit }), true);
	m.record({ skillId, situation: sit, code: "done", ok: true });
	assert.equal(m.shouldSkip({ skillId, situation: sit }), false);
});

test("recentTailFor returns most-recent entries with situation hash short form", () => {
	const m = createScenarioMemory();
	const skillId = "test.tail-" + Date.now();
	for (let i = 0; i < 5; i++) {
		m.record({ skillId, situation: `s${i}`, code: i % 2 ? "ok" : "no_target", ok: i % 2 === 1 });
	}
	const tail = m.recentTailFor({ skillId, n: 3 });
	assert.equal(tail.length, 3);
	assert.equal(tail[2].skillId, skillId);
	assert.ok(typeof tail[0].situationHashShort === "string");
});
