import { test } from "node:test";
import assert from "node:assert/strict";

import { createAntiLoop } from "./anti-loop.js";

test("fires after N failures in the window and blacklists the skill", () => {
	const al = createAntiLoop({ windowMs: 60_000, threshold: 3, blacklistMs: 30_000 });
	assert.equal(al.record({ skillId: "survive.flee", ok: false, now: 1000 }).fired, false);
	assert.equal(al.record({ skillId: "survive.flee", ok: false, now: 2000 }).fired, false);
	const third = al.record({ skillId: "survive.flee", ok: false, now: 3000 });
	assert.equal(third.fired, true);
	assert.equal(third.count, 3);
	assert.equal(al.shouldSkip("survive.flee", null, 4000), true);
	assert.equal(al.shouldSkip("survive.flee", null, 40_000), false); // blacklist expired
});

test("a success resets the fail streak", () => {
	const al = createAntiLoop({ threshold: 3 });
	al.record({ skillId: "gather.logs", ok: false, now: 1 });
	al.record({ skillId: "gather.logs", ok: false, now: 2 });
	al.record({ skillId: "gather.logs", ok: true, now: 3 });
	const r = al.record({ skillId: "gather.logs", ok: false, now: 4 });
	assert.equal(r.fired, false);
});

test("failures outside the window do not accumulate", () => {
	const al = createAntiLoop({ windowMs: 1000, threshold: 3 });
	al.record({ skillId: "s", ok: false, now: 0 });
	al.record({ skillId: "s", ok: false, now: 500 });
	const r = al.record({ skillId: "s", ok: false, now: 5000 }); // first two pruned
	assert.equal(r.fired, false);
});

test("targetKey separates loops on different targets", () => {
	const al = createAntiLoop({ threshold: 2 });
	al.record({ skillId: "mine", ok: false, targetKey: "A", now: 1 });
	const a2 = al.record({ skillId: "mine", ok: false, targetKey: "A", now: 2 });
	assert.equal(a2.fired, true);
	const b1 = al.record({ skillId: "mine", ok: false, targetKey: "B", now: 3 });
	assert.equal(b1.fired, false); // different target, own streak
});

test("drainFired returns and clears the queue", () => {
	const al = createAntiLoop({ threshold: 2 });
	al.record({ skillId: "x", ok: false, now: 1 });
	al.record({ skillId: "x", ok: false, now: 2 });
	assert.equal(al.drainFired().length, 1);
	assert.equal(al.drainFired().length, 0);
});

test("refire cooldown prevents immediate re-fire", () => {
	const al = createAntiLoop({ threshold: 2, blacklistMs: 1000, refireCooldownMs: 100_000 });
	al.record({ skillId: "x", ok: false, now: 1 });
	assert.equal(al.record({ skillId: "x", ok: false, now: 2 }).fired, true);
	// after blacklist expires, two more fails — within refire cooldown → no fire
	al.record({ skillId: "x", ok: false, now: 2000 });
	assert.equal(al.record({ skillId: "x", ok: false, now: 2100 }).fired, false);
});
