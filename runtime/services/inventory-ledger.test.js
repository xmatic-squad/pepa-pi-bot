import { test } from "node:test";
import assert from "node:assert/strict";

import { createInventoryLedger, _internal } from "./inventory-ledger.js";

function items(spec) {
	return Object.entries(spec).map(([name, count]) => ({ name, count }));
}

function fakeBot(spec) {
	return { inventory: { items: () => items(spec) } };
}

test("count + total reflect the latest snapshot", () => {
	const led = createInventoryLedger();
	led.update(fakeBot({ raw_chicken: 2, oak_log: 5, cobblestone: 12 }));
	assert.equal(led.count("raw_chicken"), 2);
	assert.equal(led.count("missing"), 0);
	assert.equal(led.total(/_log$/), 5);
	assert.equal(led.total((n) => n === "cobblestone" || n === "oak_log"), 17);
});

test("gainedSince counts only positive deltas of matching items", () => {
	const led = createInventoryLedger();
	led.update(fakeBot({ raw_chicken: 0, feather: 1 }));
	const base = led.mark();
	led.update(fakeBot({ raw_chicken: 2, feather: 3 }));
	// food matcher: raw_chicken only
	assert.equal(led.gainedSince(base, "raw_chicken"), 2);
	// regex over both
	assert.equal(led.gainedSince(base, /raw_chicken|feather/), 4);
	// a drop must not register as a gain
	led.update(fakeBot({ raw_chicken: 1, feather: 3 }));
	assert.equal(led.gainedSince(base, "raw_chicken"), 1);
});

test("acquired baselines to a wall-clock timestamp via history", () => {
	const led = createInventoryLedger();
	led.update(fakeBot({ raw_chicken: 0 }), 1000);
	led.update(fakeBot({ raw_chicken: 1 }), 2000);
	const t = 2500;
	led.update(fakeBot({ raw_chicken: 3 }), 3000);
	// since t=2500 the baseline is the snapshot at ts=2000 (count 1) → gained 2
	assert.equal(led.acquired("raw_chicken", t), 2);
	// since the very beginning → gained 3
	assert.equal(led.acquired("raw_chicken", 0), 3);
});

test("delta returns the signed diff vs a timestamp", () => {
	const led = createInventoryLedger();
	led.update(fakeBot({ oak_log: 5, dirt: 2 }), 1000);
	led.update(fakeBot({ oak_log: 8, cobblestone: 4 }), 2000);
	const d = led.delta(1000);
	assert.equal(d.oak_log, 3);
	assert.equal(d.cobblestone, 4);
	assert.equal(d.dirt, -2);
});

test("history is pruned by age and cap", () => {
	const led = createInventoryLedger({ historyMs: 1000, maxSnapshots: 100 });
	led.update(fakeBot({ a: 1 }), 0);
	led.update(fakeBot({ a: 1 }), 500);
	led.update(fakeBot({ a: 1 }), 2000); // cutoff = 2000-1000=1000 → drops ts 0 and 500
	const hist = led._history();
	assert.equal(hist.length, 1);
	assert.equal(hist[0].ts, 2000);
});

test("matchFn supports string, regex, array, set, fn", () => {
	const { matchFn } = _internal;
	assert.equal(matchFn("a")("a"), true);
	assert.equal(matchFn("a")("b"), false);
	assert.equal(matchFn(/x/)("axb"), true);
	assert.equal(matchFn(["a", "b"])("b"), true);
	assert.equal(matchFn(new Set(["c"]))("c"), true);
	assert.equal(matchFn((n) => n.length === 3)("abc"), true);
	assert.equal(matchFn(undefined)("anything"), true);
});

test("update accepts a raw items array (test convenience)", () => {
	const led = createInventoryLedger();
	led.update(items({ stick: 4 }));
	assert.equal(led.count("stick"), 4);
});
