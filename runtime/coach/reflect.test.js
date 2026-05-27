import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initKnowledge, recall, listImprovements } from "../knowledge/index.js";
import { closeStore, __resetForTests, isAvailable } from "../knowledge/store.js";
import { runOnce, __testing } from "./reflect.js";

const { buildPrompt, parseReply } = __testing;

function withTimeWebEnv(fn) {
	const prevKey = process.env.TIMEWEB_API_KEY;
	const prevModel = process.env.TIMEWEB_MODEL;
	process.env.TIMEWEB_API_KEY = "test-key";
	process.env.TIMEWEB_MODEL = "test-model";
	return Promise.resolve(fn()).finally(() => {
		if (prevKey === undefined) delete process.env.TIMEWEB_API_KEY;
		else process.env.TIMEWEB_API_KEY = prevKey;
		if (prevModel === undefined) delete process.env.TIMEWEB_MODEL;
		else process.env.TIMEWEB_MODEL = prevModel;
	});
}

test("buildPrompt: returns {system, user} with state, plan, diary, improvement schema", () => {
	const { system, user } = buildPrompt({
		snap: {
			position: { x: 600, y: 64, z: 200 },
			health: 4, food: 6, isDay: false,
			runtimeState: "emergency",
			activeSkill: "explore.far",
			currentMilestone: "wood.16",
			noProgressReason: "no_reachable_target",
			lastResult: { ok: false, code: "wedged" },
			inventory: { dirt: 12 },
		},
		journal: ['{"kind":"chopped"}'],
		scenarios: ['{"skillId":"explore.far","code":"wedged"}'],
		diary: "13:00 spawned\n13:05 died",
		plan: "1. Gather 16 logs\n2. Craft pickaxe",
		activeNeed: null,
	});
	assert.match(user, /position: \(600, 64, 200\)/);
	assert.match(user, /hp: 4 food: 6/);
	assert.match(user, /emergency/);
	assert.match(user, /Gather 16 logs/);
	assert.match(system, /Reply with ONE JSON object/);
	assert.match(system, /improvements/);
});

test("parseReply: extracts JSON from various LLM outputs", () => {
	assert.deepEqual(parseReply('{"verdict":"loop","summary":"stuck"}'), { verdict: "loop", summary: "stuck" });
	assert.deepEqual(parseReply('```json\n{"verdict":"progress"}\n```'), { verdict: "progress" });
	const longReply = 'I see... your situation. Here is my JSON:\n{"verdict":"emergency","summary":"hp critical","lessons":[]}\nDone.';
	assert.deepEqual(parseReply(longReply), { verdict: "emergency", summary: "hp critical", lessons: [] });
	assert.equal(parseReply("no json here"), null);
	assert.equal(parseReply(""), null);
});

test("runOnce: writes reflection file + records lessons + improvement requests", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pepa-reflect-test-"));
	__resetForTests();
	await initKnowledge({ stateDir: tmp });
	if (!isAvailable()) {
		try { rmSync(tmp, { recursive: true, force: true }); } catch {}
		return;
	}

	await withTimeWebEnv(async () => {
		const fakeReply = {
			verdict: "loop",
			summary: "Бот ходит по кругу, ничего не добывает.",
			next_action: "выбрать новое место под базу",
			lessons: [{
				lesson: "В этой точке постоянные смерти — искать новое место.",
				category: "survival",
				prefer_skill: "village.choose-base",
				confidence: 0.7,
			}],
			improvements: [
				{ title: "Add craft.iron-pickaxe skill", description: "Bot mines iron but cannot craft a tier-3 pickaxe.", category: "skill", priority: 2 },
			],
		};
		const askAnalyticalFn = async () => fakeReply;
		const getSnapshot = () => ({
			position: { x: 0, y: 64, z: 0 },
			health: 8, food: 10, isDay: true,
			runtimeState: "working",
			inventory: {},
		});

		const result = await runOnce({ stateDir: tmp, getSnapshot, force: true, askAnalyticalFn });
		assert.equal(result.ok, true);
		assert.equal(result.verdict, "loop");
		assert.equal(result.improvements, 1);

		const reflectionsDir = join(tmp, "reflections");
		assert.ok(existsSync(reflectionsDir));
		const files = readdirSync(reflectionsDir);
		assert.ok(files.length >= 1, `expected ≥1 reflection file, got ${files.length}`);

		const lessons = recall({ category: "survival" });
		assert.ok(lessons.some((l) => l.source === "timeweb-reflect"), "lesson recorded with source=timeweb-reflect");

		const improvements = listImprovements({ source: "reflect" });
		assert.ok(improvements.some((r) => r.title === "Add craft.iron-pickaxe skill"));
	});

	closeStore();
	try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("runOnce: skipped when LLM not configured", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pepa-reflect-test-"));
	__resetForTests();
	await initKnowledge({ stateDir: tmp });
	if (!isAvailable()) {
		try { rmSync(tmp, { recursive: true, force: true }); } catch {}
		return;
	}
	const prevKey = process.env.TIMEWEB_API_KEY;
	delete process.env.TIMEWEB_API_KEY;
	const res = await runOnce({ stateDir: tmp, getSnapshot: () => ({}), force: true });
	if (prevKey !== undefined) process.env.TIMEWEB_API_KEY = prevKey;
	assert.equal(res.ok, false);
	assert.equal(res.reason, "llm not configured");

	closeStore();
	try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("runOnce: budget exhausted → ok=false", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pepa-reflect-test-"));
	__resetForTests();
	await initKnowledge({ stateDir: tmp });
	if (!isAvailable()) {
		try { rmSync(tmp, { recursive: true, force: true }); } catch {}
		return;
	}
	await withTimeWebEnv(async () => {
		const askAnalyticalFn = async () => ({ verdict: "ok" });
		const getSnapshot = () => ({});
		await runOnce({ stateDir: tmp, getSnapshot, force: true, askAnalyticalFn });
		await runOnce({ stateDir: tmp, getSnapshot, force: true, askAnalyticalFn });
		const res = await runOnce({ stateDir: tmp, getSnapshot, force: false, askAnalyticalFn });
		assert.equal(res.ok, false);
		assert.match(res.reason ?? "", /budget|reply/);
	});
	closeStore();
	try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});
