import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initKnowledge, isAvailable, listImprovements } from "../knowledge/index.js";
import { closeStore, __resetForTests } from "../knowledge/store.js";
import { runOnce, __testing } from "./trigger-tuner.js";

const { MIN_SAMPLE } = __testing;

async function bootstrap() {
	const tmp = mkdtempSync(join(tmpdir(), "pepa-tuner-test-"));
	__resetForTests();
	await initKnowledge({ stateDir: tmp });
	return tmp;
}

function cleanup(tmp) {
	closeStore();
	try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

test("runOnce: empty stats → ok with 0 flagged", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	const r = runOnce({ stats: [] });
	assert.equal(r.ok, true);
	assert.equal(r.flagged, 0);
	cleanup(tmp);
});

test("runOnce: ignores small samples (below MIN_SAMPLE)", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	const stats = [
		{ trigger_reason: "wedged_60s", total: 2, applied: 2, succeeded: 0, failed: 2, avg_in: 700, avg_out: 40, avg_latency_ms: 5000 },
	];
	const r = runOnce({ stats });
	assert.equal(r.flagged, 0, "applied=2 is below MIN_SAMPLE; skipped");
	cleanup(tmp);
});

test("runOnce: flags low success-rate trigger as improvement", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	const stats = [
		{ trigger_reason: "wedged_60s", total: 10, applied: 10, succeeded: 1, failed: 9, avg_in: 700, avg_out: 40, avg_latency_ms: 5000 },
	];
	const r = runOnce({ stats });
	assert.equal(r.flagged, 1);
	const requests = listImprovements({ source: "tuner" });
	assert.ok(requests.some((req) => req.title.includes("wedged_60s") && req.title.includes("low success")));
	cleanup(tmp);
});

test("runOnce: flags expensive prompt with mediocre payoff", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	const stats = [
		{ trigger_reason: "repeat_4_explore.far", total: 10, applied: 10, succeeded: 4, failed: 6, avg_in: 1500, avg_out: 50, avg_latency_ms: 7000 },
	];
	const r = runOnce({ stats });
	assert.equal(r.flagged, 1);
	const requests = listImprovements({ source: "tuner", category: "tuning" });
	assert.ok(requests.some((req) => req.title.includes("expensive")));
	cleanup(tmp);
});

test("runOnce: healthy trigger does NOT get flagged", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	const stats = [
		{ trigger_reason: "emergency_hp4_creeper@3", total: 8, applied: 8, succeeded: 7, failed: 1, avg_in: 700, avg_out: 40, avg_latency_ms: 5000 },
	];
	const r = runOnce({ stats });
	assert.equal(r.flagged, 0);
	cleanup(tmp);
});

test("runOnce: re-running with same low-success stats bumps votes, not row count", async () => {
	const tmp = await bootstrap();
	if (!isAvailable()) { cleanup(tmp); return; }
	const stats = [
		{ trigger_reason: "wedged_unique_label", total: 10, applied: 10, succeeded: 1, failed: 9, avg_in: 700, avg_out: 40, avg_latency_ms: 5000 },
	];
	runOnce({ stats });
	runOnce({ stats });
	const requests = listImprovements({ source: "tuner" }).filter((r) => r.title.includes("wedged_unique_label"));
	assert.equal(requests.length, 1, "single row for the same title");
	assert.ok(requests[0].votes >= 2, "votes bumped on re-flagging");
	cleanup(tmp);
});

test("MIN_SAMPLE constant is reasonable", () => {
	assert.ok(MIN_SAMPLE >= 3 && MIN_SAMPLE <= 10);
});
