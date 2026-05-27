import { test } from "node:test";
import assert from "node:assert/strict";

import {
	tickAdvisor,
	consumeFreshRecommendation,
	getTriggerState,
	_resetForTest,
	__testing,
} from "./advisor-trigger.js";
import { _resetForTest as resetAdvisor } from "./fast-advisor.js";

const { detectTrigger, WEDGED_THRESHOLD_MS, REPEAT_THRESHOLD, PREEMPT_WINDOW_MS, RECOMMENDATION_TTL_MS } = __testing;

const API_KEY = "TIMEWEB_API_KEY";
const MODEL = "TIMEWEB_MODEL";

function withEnv(env, fn) {
	const prev = {};
	for (const k of Object.keys(env)) {
		prev[k] = process.env[k];
		if (env[k] === undefined) delete process.env[k];
		else process.env[k] = env[k];
	}
	return Promise.resolve(fn()).finally(() => {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

function stubFetch(reply, latency = 0) {
	const orig = globalThis.fetch;
	globalThis.fetch = async () => {
		if (latency) await new Promise((r) => setTimeout(r, latency));
		return {
			ok: true,
			json: async () => ({
				choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }],
				usage: { prompt_tokens: 1500, completion_tokens: 40, total_tokens: 1540 },
			}),
		};
	};
	return () => { globalThis.fetch = orig; };
}

test("detectTrigger: returns null when nothing matches", () => {
	const r = detectTrigger({ recentSkillIds: [] }, Date.now(), "gather.logs");
	assert.equal(r, null);
});

test("detectTrigger: low HP + hostile near → emergency_hp", () => {
	const now = Date.now();
	const r = detectTrigger({
		recentSkillIds: [],
		snapshot: { health: 4, closestHostile: { name: "creeper", distance: 3 } },
	}, now, "gather.logs");
	assert.match(r, /^emergency_hp4_creeper@3/);
});

test("detectTrigger: foot in lava → emergency_lava", () => {
	const now = Date.now();
	const r = detectTrigger({
		recentSkillIds: [],
		snapshot: { health: 18, hazards: { footBlock: "lava" } },
	}, now, "explore.far");
	assert.equal(r, "emergency_lava");
});

test("detectTrigger: emergency wins over wedged when both present", () => {
	const now = Date.now();
	const r = detectTrigger({
		recentSkillIds: [],
		snapshot: { health: 4, closestHostile: { name: "skeleton", distance: 5 } },
		lastSignificantMoveAt: now - 120_000,
	}, now, "x");
	assert.match(r, /^emergency_/);
});

test("detectTrigger: wedged > 60s fires", () => {
	const now = Date.now();
	const r = detectTrigger(
		{ recentSkillIds: ["x"], lastSignificantMoveAt: now - WEDGED_THRESHOLD_MS - 5000 },
		now,
		"explore.far",
	);
	assert.match(r, /^wedged_\d+s/);
});

test("detectTrigger: 4 same dispatches in row + same planned → repeat", () => {
	const now = Date.now();
	const r = detectTrigger(
		{ recentSkillIds: ["explore.far", "explore.far", "explore.far", "explore.far"] },
		now,
		"explore.far",
	);
	assert.match(r, /^repeat_4_explore\.far/);
});

test("detectTrigger: same skill repeated but planned is different → no repeat trigger", () => {
	const now = Date.now();
	const r = detectTrigger(
		{ recentSkillIds: ["explore.far", "explore.far", "explore.far", "explore.far"] },
		now,
		"gather.logs",
	);
	assert.equal(r, null);
});

test("detectTrigger: recent preempt + same skill re-planned → preempt_retry", () => {
	const now = Date.now();
	const r = detectTrigger(
		{
			recentSkillIds: ["gather.logs"],
			lastPreempt: { at: now - 5000, reason: "forced_move" },
		},
		now,
		"gather.logs",
	);
	assert.equal(r, "preempt_retry_forced_move");
});

test("detectTrigger: old preempt (> window) does not trigger", () => {
	const now = Date.now();
	const r = detectTrigger(
		{
			recentSkillIds: ["gather.logs"],
			lastPreempt: { at: now - PREEMPT_WINDOW_MS - 5000, reason: "forced_move" },
		},
		now,
		"gather.logs",
	);
	assert.equal(r, null);
});

test("tickAdvisor: disabled when TIMEWEB_API_KEY missing", async () => {
	await withEnv({ [API_KEY]: undefined }, () => {
		_resetForTest();
		const r = tickAdvisor({ recentSkillIds: [] }, { plannedSkillId: "x" });
		assert.equal(r.fired, false);
		assert.equal(r.reason, "disabled");
	});
});

test("tickAdvisor: no_trigger when ctx has nothing interesting", async () => {
	await withEnv({ [API_KEY]: "k", [MODEL]: "m" }, () => {
		_resetForTest();
		resetAdvisor();
		const r = tickAdvisor({ recentSkillIds: [] }, { plannedSkillId: "gather.logs" });
		assert.equal(r.fired, false);
		assert.equal(r.reason, "no_trigger");
	});
});

test("tickAdvisor: fires on wedged trigger and caches recommendation", async () => {
	const restore = stubFetch({
		action: "switch_skill",
		skill_id: "survive.flee",
		rationale: "Wedged here, retreat instead.",
	});
	try {
		await withEnv({ [API_KEY]: "k", [MODEL]: "m" }, async () => {
			_resetForTest();
			resetAdvisor();
			const ctx = {
				recentSkillIds: ["explore.far"],
				lastSignificantMoveAt: Date.now() - 120_000,
			};
			const r = tickAdvisor(ctx, { plannedSkillId: "explore.far" });
			assert.equal(r.fired, true);
			assert.match(r.reason, /^wedged_/);
			assert.equal(getTriggerState().inFlight, true);

			// Wait for the in-flight promise to settle.
			await new Promise((res) => setTimeout(res, 20));
			assert.equal(getTriggerState().inFlight, false);
			assert.ok(ctx.advisorRecommendation, "recommendation cached");
			assert.equal(ctx.advisorRecommendation.skillId, "survive.flee");
			assert.equal(ctx.advisorRecommendation.usage.total, 1540);
		});
	} finally { restore(); }
});

test("tickAdvisor: cooldown blocks second trigger right after", async () => {
	const restore = stubFetch({ action: "continue", rationale: "ok" });
	try {
		await withEnv({ [API_KEY]: "k", [MODEL]: "m" }, async () => {
			_resetForTest();
			resetAdvisor();
			const ctx = {
				recentSkillIds: ["explore.far"],
				lastSignificantMoveAt: Date.now() - 120_000,
			};
			const r1 = tickAdvisor(ctx, { plannedSkillId: "explore.far" });
			assert.equal(r1.fired, true);
			await new Promise((res) => setTimeout(res, 20));
			const r2 = tickAdvisor(ctx, { plannedSkillId: "explore.far" });
			assert.equal(r2.fired, false);
			assert.equal(r2.reason, "cooldown");
		});
	} finally { restore(); }
});

test("consumeFreshRecommendation: returns + clears switch_skill recommendation", () => {
	_resetForTest();
	const ctx = {
		advisorRecommendation: {
			at: Date.now(),
			action: "switch_skill",
			skillId: "survive.flee",
			rationale: "x",
		},
	};
	const r = consumeFreshRecommendation(ctx);
	assert.ok(r);
	assert.equal(r.skillId, "survive.flee");
	assert.equal(ctx.advisorRecommendation, null);
});

test("consumeFreshRecommendation: stale (> TTL) recommendation dropped", () => {
	_resetForTest();
	const ctx = {
		advisorRecommendation: {
			at: Date.now() - RECOMMENDATION_TTL_MS - 1000,
			action: "switch_skill",
			skillId: "survive.flee",
		},
	};
	const r = consumeFreshRecommendation(ctx);
	assert.equal(r, null);
	assert.equal(ctx.advisorRecommendation, null);
});

test("consumeFreshRecommendation: continue/wait recommendations are not consumed for skill swap", () => {
	_resetForTest();
	const ctx = {
		advisorRecommendation: { at: Date.now(), action: "continue", rationale: "ok" },
	};
	const r = consumeFreshRecommendation(ctx);
	assert.equal(r, null);
	// stays cached for telemetry
	assert.ok(ctx.advisorRecommendation);
});
