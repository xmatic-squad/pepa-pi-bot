import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initKnowledge, record } from "../knowledge/index.js";
import { __resetForTests, isAvailable, closeStore } from "../knowledge/store.js";
import { consult, reportOutcome, __testing } from "./advice.js";

const { SAFE_OVERRIDES } = __testing;

async function bootstrap() {
	__resetForTests();
	const tmp = mkdtempSync(join(tmpdir(), "pepa-advice-test-"));
	await initKnowledge({ stateDir: tmp });
	return tmp;
}

function cleanup(tmp) {
	closeStore();
	try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

test("consult: returns proceed when knowledge disabled", () => {
	__resetForTests();
	const res = consult({ plannedSkillId: "gather.logs", snapshot: {} });
	assert.equal(res.action, "proceed");
});

test("consult: returns proceed when no relevant lesson", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	const res = consult({ plannedSkillId: "gather.unknown-skill", snapshot: {} });
	assert.equal(res.action, "proceed");
	cleanup(tmp);
});

test("consult: starter creeper rule routes attack → survive.flee", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	const res = consult({
		plannedSkillId: "attack creeper",
		snapshot: { closestHostile: { name: "creeper", distance: 4 } },
	});
	assert.equal(res.action, "override");
	assert.equal(res.overrideSkillId, "survive.flee");
	assert.ok(res.lessonId);
	assert.ok(res.lesson);
	cleanup(tmp);
});

test("consult: avoid lesson without prefer → 'avoid' action", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	record({
		text: "Don't gather.stone — confirmed flaky.",
		category: "pathing",
		triggerSkill: "gather.stone",
		avoidSkill: "gather.stone",
		preferSkill: null,
		confidence: 0.9,
		source: "test",
	});
	const res = consult({ plannedSkillId: "gather.stone", snapshot: {} });
	assert.equal(res.action, "avoid");
	assert.ok(res.lessonId);
	cleanup(tmp);
});

test("consult: prefer outside SAFE_OVERRIDES set → falls to avoid", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	record({
		text: "test fallback",
		category: "combat",
		triggerSkill: "gather.logs",
		avoidSkill: "gather.logs",
		preferSkill: "non.standard.skill",
		confidence: 0.9,
		source: "test",
	});
	const res = consult({ plannedSkillId: "gather.logs", snapshot: {} });
	assert.equal(res.action, "avoid", "unsafe prefer falls back to avoid, not override");
	cleanup(tmp);
});

test("reportOutcome: no-op without lessonId", () => {
	reportOutcome({ lessonId: null });
	assert.ok(true);
});

test("SAFE_OVERRIDES: only contains known reflex skills", () => {
	for (const id of SAFE_OVERRIDES) {
		assert.ok(typeof id === "string" && id.includes("."), `${id} looks like a real skill id`);
	}
});
