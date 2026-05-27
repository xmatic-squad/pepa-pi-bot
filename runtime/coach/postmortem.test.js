import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initKnowledge, unanalysedDeaths, recall } from "../knowledge/index.js";
import { closeStore, __resetForTests, isAvailable } from "../knowledge/store.js";
import { attach, detach, drainOnce, __testing } from "./postmortem.js";

const { captureDeath, extractJson, inferCause, buildPrompt } = __testing;

function mockBot({ pos = { x: 100, y: 64, z: 200 }, hp = 0, food = 14, entities = {} } = {}) {
	const handlers = {};
	return {
		entity: { position: { ...pos, distanceTo(o) { return Math.hypot(pos.x - o.x, pos.z - o.z); } } },
		health: hp,
		food,
		time: { timeOfDay: 18000 },
		entities,
		isRaining: false,
		inventory: { items: () => [] },
		on(ev, fn) { handlers[ev] = fn; },
		emit(ev, payload) { handlers[ev]?.(payload); },
	};
}

test("inferCause: hostile present → 'hostile'", () => {
	assert.equal(inferCause({ bot: { food: 20, entity: { position: { y: 64 } } }, hostile: "creeper" }), "hostile");
	assert.equal(inferCause({ bot: { food: 0, entity: { position: { y: 64 } } }, hostile: null }), "starvation");
	assert.equal(inferCause({ bot: { food: 20, entity: { position: { y: 20 } } }, hostile: null }), "fall");
	assert.equal(inferCause({ bot: { food: 20, entity: { position: { y: 64 } } }, hostile: null }), "unknown");
});

test("extractJson: tolerates fences and surrounding text", () => {
	assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
	assert.deepEqual(extractJson('Reply: {"a": 2} done'), { a: 2 });
	assert.equal(extractJson("not json"), null);
	assert.equal(extractJson(""), null);
});

test("buildPrompt: returns {system, user}, includes all death rows + improvements schema", () => {
	const rows = [
		{ id: 1, ts: Date.now(), x: 100, y: 64, z: 200, cause: "hostile", hostile: "creeper", last_skill: "gather.logs", last_skill_code: "timeout", food_at_death: 14, context_blob: JSON.stringify({ recentScenarios: [{ skillId: "gather.logs", code: "timeout" }] }) },
		{ id: 2, ts: Date.now(), x: 102, y: 64, z: 201, cause: "hostile", hostile: "creeper", last_skill: "explore.far", last_skill_code: "done", food_at_death: 12, context_blob: null },
	];
	const { system, user } = buildPrompt(rows);
	assert.match(user, /death id=1/);
	assert.match(user, /death id=2/);
	assert.match(user, /creeper/);
	assert.match(system, /Reply with ONE JSON object/);
	assert.match(system, /improvements/);
	assert.match(system, /Valid skill ids/);
});

test("captureDeath: builds a row with context blob and inferred cause", () => {
	const bot = mockBot({ entities: {
		1: { type: "hostile", name: "zombie", position: { x: 101, y: 64, z: 200, distanceTo: (p) => Math.hypot(101 - p.x, 200 - p.z) } },
	}});
	const stateDir = mkdtempSync(join(tmpdir(), "pepa-coach-test-"));
	writeFileSync(join(stateDir, "current-task.json"), JSON.stringify({ label: "gather.logs", lastCode: "timeout" }));
	const death = captureDeath(bot, { stateDir });
	assert.equal(death.cause, "hostile");
	assert.equal(death.hostile, "zombie");
	assert.equal(death.lastSkill, "gather.logs");
	assert.equal(death.lastSkillCode, "timeout");
	assert.equal(death.x, 100);
	assert.ok(death.contextBlob.snapshot);
	rmSync(stateDir, { recursive: true, force: true });
});

test("attach + emit('death'): inserts row in knowledge DB", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "pepa-coach-test-"));
	__resetForTests();
	await initKnowledge({ stateDir });
	if (!isAvailable()) {
		// Without sqlite the no-op contract is enough.
		assert.ok(true);
		rmSync(stateDir, { recursive: true, force: true });
		return;
	}
	const bot = mockBot();
	attach(bot, { stateDir });
	bot.emit("death");
	// Insert is sync.
	const pending = unanalysedDeaths({ limit: 10 });
	assert.ok(pending.length >= 1, "death row inserted");
	detach();
	closeStore();
	rmSync(stateDir, { recursive: true, force: true });
});

test("drainOnce: respects budget and parses analytical LLM reply (incl. improvements)", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "pepa-coach-test-"));
	__resetForTests();
	await initKnowledge({ stateDir });
	if (!isAvailable()) {
		assert.ok(true);
		rmSync(stateDir, { recursive: true, force: true });
		return;
	}
	// Seed one unanalysed death.
	const bot = mockBot();
	attach(bot, { stateDir });
	bot.emit("death");
	detach();

	const lessonsBefore = recall({ category: "combat" }).length;

	// TimeWeb path needs env vars to satisfy the llmAvailable check.
	const prevKey = process.env.TIMEWEB_API_KEY;
	const prevModel = process.env.TIMEWEB_MODEL;
	process.env.TIMEWEB_API_KEY = "test-key";
	process.env.TIMEWEB_MODEL = "test-model";

	const fakeReply = {
		cause: "creeper_explosion_unarmed",
		next_action: "shelter at dusk",
		lessons: [{
			lesson: "Stop attacking creepers without armour; dig down 2 instead.",
			category: "combat",
			trigger_hostile: "creeper",
			avoid_skill: "attack creeper",
			prefer_skill: "survive.flee",
			confidence: 0.85,
		}],
		improvements: [
			{ title: "Add craft.shield skill", description: "No skill to craft a shield when creepers are around.", category: "skill", priority: 2 },
		],
	};
	const askAnalyticalFn = async () => fakeReply;

	const result = await drainOnce({ stateDir, force: true, askAnalyticalFn });

	if (prevKey === undefined) delete process.env.TIMEWEB_API_KEY;
	else process.env.TIMEWEB_API_KEY = prevKey;
	if (prevModel === undefined) delete process.env.TIMEWEB_MODEL;
	else process.env.TIMEWEB_MODEL = prevModel;

	assert.equal(result.ok, true);
	assert.equal(result.analysed, 1);
	assert.equal(result.lessons, 1);
	assert.equal(result.improvements, 1);

	const after = recall({ hostile: "creeper", category: "combat" });
	assert.ok(after.length > lessonsBefore, "new lesson recorded");

	const stillPending = unanalysedDeaths({ limit: 10 });
	assert.equal(stillPending.length, 0, "death marked analysed");

	closeStore();
	rmSync(stateDir, { recursive: true, force: true });
});

test("drainOnce: skipped when LLM not configured", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "pepa-coach-test-"));
	__resetForTests();
	await initKnowledge({ stateDir });
	if (!isAvailable()) {
		rmSync(stateDir, { recursive: true, force: true });
		return;
	}
	const prevKey = process.env.TIMEWEB_API_KEY;
	delete process.env.TIMEWEB_API_KEY;
	const result = await drainOnce({ stateDir, force: true });
	if (prevKey !== undefined) process.env.TIMEWEB_API_KEY = prevKey;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "llm not configured");
	closeStore();
	rmSync(stateDir, { recursive: true, force: true });
});
