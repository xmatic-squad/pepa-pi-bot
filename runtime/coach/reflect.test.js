import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initKnowledge, recall } from "../knowledge/index.js";
import { closeStore, __resetForTests, isAvailable } from "../knowledge/store.js";
import { runOnce, __testing } from "./reflect.js";

const { buildPrompt, parseReply } = __testing;

test("buildPrompt: includes runtime state + plan + diary", () => {
	const p = buildPrompt({
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
	});
	assert.match(p, /position: \(600, 64, 200\)/);
	assert.match(p, /hp: 4 food: 6/);
	assert.match(p, /emergency/);
	assert.match(p, /Gather 16 logs/);
	assert.match(p, /Reply with ONE JSON object/);
});

test("parseReply: extracts JSON from various Pi outputs", () => {
	assert.deepEqual(parseReply('{"verdict":"loop","summary":"stuck"}'), { verdict: "loop", summary: "stuck" });
	assert.deepEqual(parseReply('```json\n{"verdict":"progress"}\n```'), { verdict: "progress" });
	const longReply = 'I see... your situation. Here is my JSON:\n{"verdict":"emergency","summary":"hp critical","lessons":[]}\nDone.';
	assert.deepEqual(parseReply(longReply), { verdict: "emergency", summary: "hp critical", lessons: [] });
	assert.equal(parseReply("no json here"), null);
	assert.equal(parseReply(""), null);
});

test("runOnce: writes reflection file + records lessons", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pepa-reflect-test-"));
	__resetForTests();
	await initKnowledge({ stateDir: tmp });
	if (!isAvailable()) {
		try { rmSync(tmp, { recursive: true, force: true }); } catch {}
		return;
	}

	const fakeReply = JSON.stringify({
		verdict: "loop",
		summary: "Бот ходит по кругу, ничего не добывает.",
		next_action: "выбрать новое место под базу",
		lessons: [{
			lesson: "В этой точке постоянные смерти — искать новое место.",
			category: "survival",
			prefer_skill: "village.choose-base",
			confidence: 0.7,
		}],
	});
	const askPi = ({ onChunk, onDone }) => {
		onChunk({ stream: "stdout", text: fakeReply });
		onDone({ code: 0 });
	};
	const getSnapshot = () => ({
		position: { x: 0, y: 64, z: 0 },
		health: 8, food: 10, isDay: true,
		runtimeState: "working",
		inventory: {},
	});

	const result = await runOnce({ stateDir: tmp, askPi, getSnapshot, force: true });
	assert.equal(result.ok, true);
	assert.equal(result.verdict, "loop");

	const reflectionsDir = join(tmp, "reflections");
	assert.ok(existsSync(reflectionsDir));
	const files = readdirSync(reflectionsDir);
	assert.ok(files.length >= 1, `expected ≥1 reflection file, got ${files.length}`);

	const lessons = recall({ category: "survival" });
	assert.ok(lessons.some((l) => l.source === "pi-reflect"), "lesson recorded with source=pi-reflect");

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
	const askPi = ({ onDone }) => onDone({ code: 0 });
	const getSnapshot = () => ({});
	// Fire 2 forced calls to exhaust budget; 3rd without force should fail.
	await runOnce({ stateDir: tmp, askPi, getSnapshot, force: true });
	await runOnce({ stateDir: tmp, askPi, getSnapshot, force: true });
	const res = await runOnce({ stateDir: tmp, askPi, getSnapshot, force: false });
	assert.equal(res.ok, false);
	assert.match(res.reason ?? "", /budget|reply/);

	closeStore();
	try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});
