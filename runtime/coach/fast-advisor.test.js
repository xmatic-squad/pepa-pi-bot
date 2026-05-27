import { test } from "node:test";
import assert from "node:assert/strict";

import { advise, isAvailable, _resetForTest, __testing } from "./fast-advisor.js";

const API_KEY = "PEPA_FAST_LLM_API_KEY";
const MODEL = "PEPA_FAST_LLM_MODEL";
const BASE = "PEPA_FAST_LLM_BASE_URL";

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

function stubFetch(reply) {
	const calls = [];
	const orig = globalThis.fetch;
	globalThis.fetch = async (url, opts) => {
		calls.push({ url, opts });
		return {
			ok: true,
			json: async () => ({
				choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }],
			}),
		};
	};
	return { calls, restore() { globalThis.fetch = orig; } };
}

test("advise: not_configured without API key", async () => {
	await withEnv({ [API_KEY]: undefined }, async () => {
		_resetForTest();
		const res = await advise({ reason: "stuck" });
		assert.equal(res.ok, false);
		assert.equal(res.code, "not_configured");
	});
});

test("advise: accepts a registered skill", async () => {
	const f = stubFetch({ action: "switch_skill", skill_id: "survive.flee", rationale: "creeper close" });
	try {
		await withEnv({ [API_KEY]: "k", [MODEL]: "m", [BASE]: "https://x/v1" }, async () => {
			_resetForTest();
			const res = await advise({
				snapshot: { health: 10, food: 18, isDay: true, position: { x: 1, y: 64, z: 1 } },
				reason: "wedged_60s",
				recentSkillIds: ["explore.far", "explore.far", "explore.far"],
				force: true,
			});
			assert.equal(res.ok, true);
			assert.equal(res.action, "switch_skill");
			assert.equal(res.skillId, "survive.flee");
			assert.match(res.rationale, /creeper/);
			// system prompt should mention the live registry
			const sent = JSON.parse(f.calls[0].opts.body);
			assert.match(sent.messages[0].content, /Valid skill ids/);
			assert.match(sent.messages[0].content, /survive\.flee/);
			assert.match(sent.messages[1].content, /wedged_60s/);
		});
	} finally { f.restore(); }
});

test("advise: rejects hallucinated skill id with code=hallucinated_skill", async () => {
	const f = stubFetch({ action: "switch_skill", skill_id: "relocate.surface", rationale: "fresh spot" });
	try {
		await withEnv({ [API_KEY]: "k", [MODEL]: "m" }, async () => {
			_resetForTest();
			const res = await advise({ reason: "loop", force: true });
			assert.equal(res.ok, false);
			assert.equal(res.code, "hallucinated_skill");
			assert.equal(res.detail, "relocate.surface");
		});
	} finally { f.restore(); }
});

test("advise: accepts 'continue' and 'wait' without skill_id", async () => {
	const f = stubFetch({ action: "continue", rationale: "skill is making slow progress" });
	try {
		await withEnv({ [API_KEY]: "k", [MODEL]: "m" }, async () => {
			_resetForTest();
			const res = await advise({ reason: "tick", force: true });
			assert.equal(res.ok, true);
			assert.equal(res.action, "continue");
		});
	} finally { f.restore(); }
});

test("advise: rate-limit cooldown blocks rapid calls", async () => {
	const f = stubFetch({ action: "continue", rationale: "ok" });
	try {
		await withEnv({ [API_KEY]: "k", [MODEL]: "m" }, async () => {
			_resetForTest();
			const r1 = await advise({ reason: "x" });
			assert.equal(r1.ok, true);
			const r2 = await advise({ reason: "y" });
			assert.equal(r2.ok, false);
			assert.equal(r2.code, "cooldown");
		});
	} finally { f.restore(); }
});

test("advise: hourly budget enforced with force=true override", async () => {
	const f = stubFetch({ action: "continue", rationale: "ok" });
	try {
		await withEnv({ [API_KEY]: "k", [MODEL]: "m" }, async () => {
			_resetForTest();
			for (let i = 0; i < __testing.HOURLY_BUDGET; i++) {
				await advise({ reason: `t${i}`, force: true });
			}
			const over = await advise({ reason: "over" });
			assert.equal(over.ok, false);
			assert.equal(over.code, "budget_exhausted");
		});
	} finally { f.restore(); }
});

test("buildSystemPrompt: contains registry block and JSON schema", () => {
	const sys = __testing.buildSystemPrompt();
	assert.match(sys, /switch_skill/);
	assert.match(sys, /Valid skill ids/);
	assert.match(sys, /survive\.flee/);
});

test("buildUserPrompt: includes trigger and recent skills", () => {
	const u = __testing.buildUserPrompt({
		snapshot: { health: 4, food: 3, isDay: false, position: { x: 10, y: 65, z: 10 }, activeSkill: "explore.far" },
		reason: "hp_plunge",
		recentSkillIds: ["explore.far", "explore.far"],
		lessonsTail: [{ text: "do not fight at night" }],
	});
	assert.match(u, /hp_plunge/);
	assert.match(u, /HP: 4/);
	assert.match(u, /Recent dispatches: explore\.far → explore\.far/);
	assert.match(u, /do not fight at night/);
});

test("formatThreats: empty / formatted", () => {
	assert.equal(__testing.formatThreats(undefined), "(none)");
	assert.equal(__testing.formatThreats([]), "(none)");
	assert.equal(
		__testing.formatThreats([{ name: "zombie", distance: 4.3 }, { name: "creeper", distance: 7 }]),
		"zombie@4m, creeper@7m",
	);
});

test("isAvailable mirrors provider availability", async () => {
	await withEnv({ [API_KEY]: undefined }, async () => {
		assert.equal(isAvailable(), false);
	});
	await withEnv({ [API_KEY]: "k" }, async () => {
		assert.equal(isAvailable(), true);
	});
});
