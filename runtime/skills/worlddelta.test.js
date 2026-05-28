import { test } from "node:test";
import assert from "node:assert/strict";

import { runSkill, _registerForTest } from "./index.js";
import { createInventoryLedger } from "../services/inventory-ledger.js";

function botWithMutableInv(initial) {
	let inv = initial;
	return {
		bot: { inventory: { items: () => inv } },
		set(next) { inv = next; },
	};
}

test("expectGain passes and attaches the observed inventory delta", async () => {
	const m = botWithMutableInv([{ name: "cobblestone", count: 0 }]);
	const ledger = createInventoryLedger();
	ledger.update(m.bot);
	const teardown = _registerForTest({
		id: "test.mine-ok",
		title: "t", timeoutMs: 1000,
		preconditions: () => ({ ok: true }),
		execute: async () => { m.set([{ name: "cobblestone", count: 5 }]); return { ok: true, code: "done", worldDelta: {} }; },
		expectGain: { matcher: "cobblestone", min: 1, label: "cobblestone" },
	});
	const res = await runSkill("test.mine-ok", { bot: m.bot, ledger });
	teardown();
	assert.equal(res.ok, true);
	assert.equal(res.worldDelta._invObserved.cobblestone, 5);
});

test("expectGain fails with world_unchanged when the world did not move", async () => {
	const m = botWithMutableInv([{ name: "cobblestone", count: 0 }]);
	const ledger = createInventoryLedger();
	ledger.update(m.bot);
	const teardown = _registerForTest({
		id: "test.mine-liar",
		title: "t", timeoutMs: 1000,
		preconditions: () => ({ ok: true }),
		execute: async () => ({ ok: true, code: "done", worldDelta: {} }), // claims ok, gains nothing
		expectGain: { matcher: "cobblestone", min: 1, label: "cobblestone" },
	});
	const res = await runSkill("test.mine-liar", { bot: m.bot, ledger });
	teardown();
	assert.equal(res.ok, false);
	assert.equal(res.code, "world_unchanged");
});

test("no ledger in ctx → no validation, skill passes untouched", async () => {
	const teardown = _registerForTest({
		id: "test.no-ledger",
		title: "t", timeoutMs: 1000,
		preconditions: () => ({ ok: true }),
		execute: async () => ({ ok: true, code: "done", worldDelta: { foo: 1 } }),
		expectGain: { matcher: "diamond", min: 1 },
	});
	const res = await runSkill("test.no-ledger", { bot: { inventory: { items: () => [] } } });
	teardown();
	assert.equal(res.ok, true);
	assert.equal(res.worldDelta.foo, 1);
});

test("observed delta is attached even without expectGain", async () => {
	const m = botWithMutableInv([{ name: "oak_log", count: 2 }]);
	const ledger = createInventoryLedger();
	ledger.update(m.bot);
	const teardown = _registerForTest({
		id: "test.observe-only",
		title: "t", timeoutMs: 1000,
		preconditions: () => ({ ok: true }),
		execute: async () => { m.set([{ name: "oak_log", count: 6 }]); return { ok: true, code: "done", worldDelta: null }; },
	});
	const res = await runSkill("test.observe-only", { bot: m.bot, ledger });
	teardown();
	assert.equal(res.ok, true);
	assert.equal(res.worldDelta._invObserved.oak_log, 4);
});
