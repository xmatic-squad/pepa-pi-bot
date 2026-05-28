import { test } from "node:test";
import assert from "node:assert/strict";

import { approachBlock, _internal } from "./_common.js";

test("blockPos floors a position; blockCenter offsets to centre", () => {
	assert.deepEqual(_internal.blockPos({ x: 10.9, y: 64.2, z: -3.7 }), { x: 10, y: 64, z: -4 });
	assert.deepEqual(_internal.blockCenter({ position: { x: 10, y: 64, z: -4 } }), { x: 10.5, y: 64.5, z: -3.5 });
});

test("withinReach respects the radius", () => {
	assert.equal(_internal.withinReach({ x: 0.5, y: 64.5, z: 0.5 }, { x: 0, y: 64, z: 0 }, 4), true);
	assert.equal(_internal.withinReach({ x: 20, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, 4), false);
});

test("approachBlock returns no_target without a target", async () => {
	const r = await approachBlock({ bot: { entity: { position: { x: 0, y: 64, z: 0 } } } }, null);
	assert.equal(r.ok, false);
	assert.equal(r.code, "no_target");
});

test("approachBlock looks at the block when already in reach (no path needed)", async () => {
	let looked = false;
	let gotoCalled = false;
	const ctx = {
		bot: {
			entity: { position: { x: 0.5, y: 64, z: 0.5 } },
			async lookAt() { looked = true; },
		},
		motion: { gotoSafe: async () => { gotoCalled = true; return { ok: true, code: "reached" }; } },
	};
	const r = await approachBlock(ctx, { x: 0, y: 64, z: 0 }, { reachCheck: 4 });
	assert.equal(r.ok, true);
	assert.equal(looked, true);
	assert.equal(gotoCalled, false, "should not path when already in reach");
});

test("approachBlock uses motion.gotoSafe to close distance, then looks", async () => {
	let looked = false;
	const ctx = {
		bot: {
			// starts far, motion 'moves' it into reach by mutating position
			entity: { position: { x: 30, y: 64, z: 0 } },
			async lookAt() { looked = true; },
		},
		motion: {
			gotoSafe: async () => { ctx.bot.entity.position = { x: 0.6, y: 64, z: 0.6 }; return { ok: true, code: "reached" }; },
		},
	};
	const r = await approachBlock(ctx, { x: 0, y: 64, z: 0 });
	assert.equal(r.ok, true);
	assert.equal(looked, true);
	assert.ok(r.distance <= 4);
});

test("approachBlock fails when motion can't get into reach", async () => {
	const ctx = {
		bot: {
			entity: { position: { x: 30, y: 64, z: 0 } }, // never moves
			async lookAt() {},
		},
		motion: { gotoSafe: async () => ({ ok: false, code: "stuck" }) },
	};
	const r = await approachBlock(ctx, { x: 0, y: 64, z: 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, "stuck");
});
