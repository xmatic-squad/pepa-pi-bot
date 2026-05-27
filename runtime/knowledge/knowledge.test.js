import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	initKnowledge,
	isAvailable,
	disabledReason,
	lookupRecipe,
	lookupMob,
	lookupBlock,
	recall,
	record,
	markApplied,
	topAdvice,
	insertDeath,
	unanalysedDeaths,
	markDeathAnalysed,
	insertPostmortem,
	recordPOI,
	poiNearby,
	logChat,
	insertRecommendation,
	markRecommendationApplied,
	markRecommendationOutcome,
	recommendationStats,
	recentRecommendations,
	createImprovementRequest,
	listImprovements,
	markImprovementStatus,
} from "./index.js";
import { __resetForTests, closeStore } from "./store.js";

// All tests share one DB in a tmp dir per run. The first test bootstraps,
// later tests assume init has happened. When `better-sqlite3` is not
// installed, `isAvailable()` stays false and every test asserts the
// graceful no-op contract instead.

const tmp = mkdtempSync(join(tmpdir(), "pepa-knowledge-test-"));
let bootstrapped = false;

async function bootstrap() {
	if (bootstrapped) return;
	__resetForTests();
	await initKnowledge({ stateDir: tmp });
	bootstrapped = true;
}

test("init: opens store or stays disabled gracefully", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.match(disabledReason() ?? "", /better-sqlite3|store/i,
			"when unavailable, disabledReason should explain why");
		return; // rest of suite covered by no-op assertions below
	}
	assert.equal(typeof isAvailable(), "boolean");
});

test("seed: recipes, mobs, blocks, lessons present", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.equal(lookupRecipe("planks"), null);
		assert.equal(lookupMob("creeper"), null);
		assert.equal(lookupBlock("oak_log"), null);
		assert.deepEqual(recall(), []);
		return;
	}
	const planks = lookupRecipe("planks");
	assert.ok(planks, "planks recipe seeded");
	assert.equal(planks.yields, 4);

	const creeper = lookupMob("creeper");
	assert.ok(creeper, "creeper intel seeded");
	assert.equal(creeper.threat_level, 5);
	assert.equal(creeper.verdict_no_weapon, "flee");

	const oak = lookupBlock("oak_log");
	assert.ok(oak, "oak_log intel seeded");
	assert.equal(oak.required_tool, "axe");

	const lessons = recall();
	assert.ok(lessons.length >= 5, `expected ≥5 starter lessons, got ${lessons.length}`);
});

test("recall: filter by hostile narrows results", async () => {
	await bootstrap();
	if (!isAvailable()) return;
	const all = recall();
	const creeperLessons = recall({ hostile: "creeper" });
	assert.ok(creeperLessons.length > 0, "creeper-specific lessons exist");
	assert.ok(creeperLessons.every(
		(l) => l.trigger_hostile === null || l.trigger_hostile === "creeper",
	), "filter excludes other hostiles");
	assert.ok(creeperLessons.length <= all.length);
});

test("record: insert custom lesson, retrievable by category", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.equal(record({ text: "noop", category: "combat" }).ok, false);
		return;
	}
	const { ok, id } = record({
		text: "Stop attacking creepers with fists — confirmed 30 deaths in spawn area.",
		category: "combat",
		triggerHostile: "creeper",
		avoidSkill: "attack creeper",
		preferSkill: "survive.flee",
		confidence: 0.8,
		source: "test",
	});
	assert.equal(ok, true);
	assert.ok(typeof id === "number" || typeof id === "bigint");

	const lessons = recall({ hostile: "creeper", category: "combat" });
	assert.ok(lessons.some((l) => l.id === Number(id)));
});

test("markApplied: increments counters, adjusts confidence", async () => {
	await bootstrap();
	if (!isAvailable()) return;
	const { id } = record({
		text: "test-applied-lesson", category: "pathing", confidence: 0.5, source: "test",
	});
	markApplied(id, { succeeded: true });
	markApplied(id, { succeeded: true });
	markApplied(id, { succeeded: false });
	const found = recall({ category: "pathing" }).find((l) => l.id === Number(id));
	assert.ok(found, "lesson retrievable after marks");
	assert.equal(found.applied_count, 3);
	assert.equal(found.succeeded_count, 2);
	assert.ok(found.confidence > 0.5, "two successes outweighed one failure");
});

test("topAdvice: returns null when no high-confidence lesson matches", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.deepEqual(topAdvice({ hostile: "creeper" }), { avoid: null, prefer: null, lessonId: null, lesson: null });
		return;
	}
	// Starter rule for creeper is confidence 0.95, with avoid + prefer set.
	const advice = topAdvice({ hostile: "creeper" });
	assert.equal(advice.avoid, "attack creeper");
	assert.equal(advice.prefer, "survive.flee");
	assert.ok(advice.lesson);

	// Unrelated mob → no specific advice usually.
	const noneAdvice = topAdvice({ hostile: "rabbit" });
	// Either no advice OR a generic lesson without avoid/prefer set. Both fine.
	if (noneAdvice.avoid || noneAdvice.prefer) {
		assert.ok(typeof noneAdvice.lesson === "string");
	}
});

test("death + postmortem round-trip", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.equal(insertDeath({ ts: 1, x: 0, y: 0, z: 0 }), null);
		return;
	}
	const deathId = insertDeath({
		ts: Date.now(),
		x: 100, y: 64, z: 200,
		cause: "hostile",
		hostile: "creeper",
		lastSkill: "gather.logs",
		lastSkillCode: "timeout",
		hp: 0,
		food: 14,
		inventoryLost: [{ name: "oak_log", count: 4 }],
		contextBlob: { lastTicks: ["wandered E", "noticed creeper at 6m", "boom"] },
	});
	assert.ok(deathId);

	const pending = unanalysedDeaths({ limit: 10 });
	assert.ok(pending.some((d) => d.id === Number(deathId)));

	const pmId = insertPostmortem({
		deathId,
		cause: "creeper_explosion_in_open",
		lesson: "Don't gather logs at night without armor.",
		nextAction: "shelter, then gather at dawn",
		rawResponse: '{"cause":"creeper"}',
	});
	assert.ok(pmId);

	markDeathAnalysed(deathId);
	const stillPending = unanalysedDeaths({ limit: 10 });
	assert.ok(!stillPending.some((d) => d.id === Number(deathId)));
});

test("poi: insert + nearby query", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.equal(recordPOI({ kind: "tree", x: 0, y: 64, z: 0 }), null);
		assert.deepEqual(poiNearby({ x: 0, z: 0 }), []);
		return;
	}
	recordPOI({ kind: "tree", x: 100, y: 64, z: 100, notes: "oak cluster" });
	recordPOI({ kind: "tree", x: 110, y: 64, z: 102 });
	recordPOI({ kind: "tree", x: 500, y: 64, z: 500 });
	recordPOI({ kind: "danger", x: 100, y: 64, z: 100, notes: "creeper spawned here" });

	const near = poiNearby({ x: 100, z: 100, kind: "tree", radius: 32 });
	assert.equal(near.length, 2);
	assert.ok(near[0].dist2 < 200, "nearest first");

	const far = poiNearby({ x: 100, z: 100, kind: "tree", radius: 8 });
	assert.equal(far.length, 1, "radius 8 excludes the second tree at (110,102)");

	const danger = poiNearby({ x: 100, z: 100, kind: "danger", radius: 32 });
	assert.equal(danger.length, 1);
});

test("chat log: append + select", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.equal(logChat({ text: "hi", speaker: "alice" }), null);
		return;
	}
	const id1 = logChat({ direction: "in", speaker: "alice", text: "привет", intent: "GREETING" });
	const id2 = logChat({ direction: "out", text: "yo", repliedWith: "template" });
	assert.ok(id1 && id2);
});

// ---- v0.3.0 advisor recommendations ---------------------------------------

test("advisor recommendations: insert → markApplied → markOutcome → stats", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.equal(insertRecommendation({ triggerReason: "x", action: "switch_skill" }), null);
		return;
	}
	const id = insertRecommendation({
		triggerReason: "wedged_90s",
		plannedSkill: "explore.far",
		recommendedSkill: "recovery.tunnel-out",
		action: "switch_skill",
		rationale: "Stuck wedged, tunnel out.",
		activeNeed: "L2 tools_wood",
		tokensIn: 700, tokensOut: 40, latencyMs: 5000,
	});
	assert.ok(id, "got recommendation id");
	markRecommendationApplied(id);
	markRecommendationOutcome(id, { ok: true, code: "done" });

	const recent = recentRecommendations({ limit: 5 });
	const row = recent.find((r) => r.id === id);
	assert.ok(row);
	assert.equal(row.applied, 1);
	assert.equal(row.outcome_ok, 1);

	// second insert with same trigger to test stats grouping
	const id2 = insertRecommendation({
		triggerReason: "wedged_90s",
		plannedSkill: "explore.far",
		recommendedSkill: "survive.pillar-up",
		action: "switch_skill",
		rationale: "Try pillar.",
		tokensIn: 720, tokensOut: 50, latencyMs: 6000,
	});
	markRecommendationApplied(id2);
	markRecommendationOutcome(id2, { ok: false, code: "no_progress" });

	const stats = recommendationStats({ sinceHours: 24 });
	const wedged = stats.find((s) => s.trigger_reason === "wedged_90s");
	assert.ok(wedged);
	assert.equal(wedged.total, 2);
	assert.equal(wedged.applied, 2);
	assert.equal(wedged.succeeded, 1);
	assert.equal(wedged.failed, 1);
});

test("advisor recommendations: graceful no-op on unknown id", async () => {
	await bootstrap();
	if (!isAvailable()) return;
	markRecommendationApplied(null);
	markRecommendationOutcome(null, { ok: true });
	markRecommendationOutcome(999999, { ok: true });
	// no throw = pass
});

// ---- v0.3.0 improvement requests ------------------------------------------

test("improvement requests: create, dedup-by-title bumps votes, list filters", async () => {
	await bootstrap();
	if (!isAvailable()) {
		assert.equal(createImprovementRequest({ title: "x" }), null);
		return;
	}
	const id1 = createImprovementRequest({
		source: "postmortem",
		category: "skill",
		title: "Add craft.iron-pickaxe skill",
		description: "Bot has iron ingots but no skill to craft tier-3 pickaxe.",
		priority: 2,
	});
	assert.ok(id1);

	// duplicate title → bumps votes, returns same id
	const id2 = createImprovementRequest({
		source: "reflect",
		category: "skill",
		title: "Add craft.iron-pickaxe skill",
		priority: 2,
	});
	assert.equal(id2, id1, "dedup returns original id");

	const list = listImprovements({ status: "open", category: "skill" });
	const row = list.find((r) => r.id === id1);
	assert.ok(row);
	assert.equal(row.votes, 2, "votes bumped by duplicate");

	markImprovementStatus(id1, { status: "implemented", notes: "Shipped in v0.3.1" });
	const updated = listImprovements({ status: "implemented" });
	assert.ok(updated.some((r) => r.id === id1));
	const stillOpen = listImprovements({ status: "open" });
	assert.ok(!stillOpen.some((r) => r.id === id1));
});

test("improvement requests: priority and status ordering", async () => {
	await bootstrap();
	if (!isAvailable()) return;
	const a = createImprovementRequest({ source: "manual", title: "low-prio thing", priority: 5 });
	const b = createImprovementRequest({ source: "manual", title: "high-prio thing", priority: 1 });
	const list = listImprovements({ status: "open" });
	const ai = list.findIndex((r) => r.id === a);
	const bi = list.findIndex((r) => r.id === b);
	assert.ok(bi < ai, "priority 1 listed before priority 5");
});

// Cleanup: close DB and remove tmp dir.
test("teardown", () => {
	closeStore();
	try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});
