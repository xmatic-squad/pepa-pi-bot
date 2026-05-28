import { test } from "node:test";
import assert from "node:assert/strict";

import { skill } from "./flee.js";

function vec(x, y, z) {
	return {
		x, y, z,
		clone() { return vec(x, y, z); },
		distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z); },
		offset(dx, dy, dz) { return vec(x + dx, y + dy, z + dz); },
	};
}

function fakeBot({ moveOnForward = 0 } = {}) {
	const bot = {
		entity: { position: vec(0, 64, 0), yaw: 0 },
		entities: { z1: { name: "zombie", position: vec(2, 64, 0) } },
		loadPlugin() {},
		pathfinder: { goto: () => new Promise(() => {}), stop() {}, setMovements() {} },
		setControlState(name, on) {
			if (name === "forward" && on && moveOnForward) {
				bot.entity.position = vec(moveOnForward, 64, 0);
			}
		},
		async look() {},
	};
	return bot;
}

test("flee returns done when motion reaches the retreat point", async () => {
	const bot = fakeBot();
	const ctx = { bot, motion: { gotoSafe: async () => ({ ok: true, code: "reached", movedBlocks: 16 }) } };
	const res = await skill.execute(ctx, {});
	assert.equal(res.ok, true);
	assert.equal(res.code, "done");
	assert.ok(res.worldDelta.fledTo);
});

test("flee falls back to blind retreat and succeeds when it moves far enough", async () => {
	const bot = fakeBot({ moveOnForward: 8 });
	const ctx = { bot, motion: { gotoSafe: async () => ({ ok: false, code: "stuck", movedBlocks: 0 }) } };
	const res = await skill.execute(ctx, { blindMs: 20 });
	assert.equal(res.ok, true);
	assert.equal(res.detail.mode, "blind-retreat");
});

test("flee surfaces the structured motion code when stuck and blind retreat fails", async () => {
	const bot = fakeBot({ moveOnForward: 0 }); // never moves
	const ctx = { bot, motion: { gotoSafe: async () => ({ ok: false, code: "stuck", movedBlocks: 0 }) } };
	const res = await skill.execute(ctx, { blindMs: 20 });
	assert.equal(res.ok, false);
	assert.equal(res.code, "stuck");
});

test("flee precondition fails with no hostile", () => {
	const bot = fakeBot();
	bot.entities = {};
	const pre = skill.preconditions({ bot }, {});
	assert.equal(pre.ok, false);
	assert.equal(pre.code, "no_hostile");
});
