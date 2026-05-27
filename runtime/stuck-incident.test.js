// Tests for runtime/stuck-incident.js and runtime/skill-metrics.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createStuckIncidentDetector } from "./stuck-incident.js";
import { createSkillMetrics } from "./skill-metrics.js";

function snap(reason, extras = {}) {
	return {
		connected: true,
		noProgressReason: reason,
		runtimeState: "idle",
		inventory: {},
		curriculum: extras.curriculum ?? null,
		position: { x: 0, y: 64, z: 0 },
		health: 20,
		food: 18,
		isDay: true,
		...extras,
	};
}

test("returns null while reason is absent", () => {
	const d = createStuckIncidentDetector({ thresholdMs: 100, cooldownMs: 1_000 });
	assert.equal(d.check({ snapshot: snap(null), now: 0 }), null);
	assert.equal(d.check({ snapshot: snap(null), now: 50 }), null);
});

test("does not fire before threshold elapses", () => {
	const d = createStuckIncidentDetector({ thresholdMs: 100, cooldownMs: 1_000 });
	assert.equal(d.check({ snapshot: snap("planner_empty"), now: 0 }), null);
	assert.equal(d.check({ snapshot: snap("planner_empty"), now: 50 }), null);
	assert.equal(d.check({ snapshot: snap("planner_empty"), now: 99 }), null);
});

test("fires after threshold and includes scope + body", () => {
	const d = createStuckIncidentDetector({ thresholdMs: 100, cooldownMs: 1_000 });
	d.check({ snapshot: snap("no_food_source"), now: 0 });
	const out = d.check({
		snapshot: snap("no_food_source", {
			curriculum: { milestone: { title: "Secure food" }, plan: { skillId: "survive.eat" } },
		}),
		lastResult: { label: "survive.eat", ok: false, code: "no_food_source", detail: "no edible item" },
		metrics: { "survive.eat": { ok: 0, fail: 3 } },
		now: 200,
	});
	assert.ok(out);
	assert.equal(out.fire, true);
	assert.equal(out.kind, "stuck-no_food_source");
	assert.match(out.summary, /no_food_source/);
	assert.match(out.body, /Secure food/);
	assert.match(out.body, /survive\.eat/);
	assert.ok(out.editScope.some((p) => p.includes("survive-eat") || p.includes("survive.eat") || p === "runtime/skills/"));
});

test("changes in reason restart the timer (no premature fire)", () => {
	const d = createStuckIncidentDetector({ thresholdMs: 100, cooldownMs: 1_000 });
	d.check({ snapshot: snap("planner_empty"), now: 0 });
	d.check({ snapshot: snap("planner_empty"), now: 80 });
	// reason changes — restart
	assert.equal(d.check({ snapshot: snap("no_food_source"), now: 100 }), null);
	// only the NEW reason's clock counts now
	assert.equal(d.check({ snapshot: snap("no_food_source"), now: 150 }), null);
});

test("cooldown prevents back-to-back firings", () => {
	const d = createStuckIncidentDetector({ thresholdMs: 50, cooldownMs: 1_000 });
	d.check({ snapshot: snap("planner_empty"), now: 0 });
	const first = d.check({ snapshot: snap("planner_empty"), now: 100 });
	assert.ok(first?.fire);
	const second = d.check({ snapshot: snap("planner_empty"), now: 200 });
	assert.equal(second, null);
});

test("skill metrics record ok/fail and expose snapshot", () => {
	const m = createSkillMetrics({ persist: false });
	m.record("gather.logs", true);
	m.record("gather.logs", true);
	m.record("gather.logs", false);
	m.record("survive.eat", false);
	const snap = m.snapshot();
	assert.equal(snap["gather.logs"].ok, 2);
	assert.equal(snap["gather.logs"].fail, 1);
	assert.equal(snap["survive.eat"].fail, 1);
});
