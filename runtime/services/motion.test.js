import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createMotionService, classifyGotoError, _internal } from "./motion.js";

function makeBot({ goto, startPos = { x: 0, y: 64, z: 0 } }) {
	const em = new EventEmitter();
	const bot = {
		entity: { position: { ...startPos } },
		pathfinder: {
			goto,
			_stopped: false,
			stop() { this._stopped = true; },
		},
		on: (...a) => em.on(...a),
		removeListener: (...a) => em.removeListener(...a),
		emit: (...a) => em.emit(...a),
		loadPlugin() {},
	};
	return bot;
}

const NEVER = () => new Promise(() => {});

test("reached: goto resolves → ok/reached, pathfinder not stopped", async () => {
	const bot = makeBot({ goto: () => Promise.resolve() });
	const m = createMotionService(bot);
	const r = await m.gotoSafe({}, { timeoutMs: 1000, stuckWindowMs: 1000, pollMs: 20, graceMs: 0 });
	assert.equal(r.ok, true);
	assert.equal(r.code, "reached");
	assert.equal(bot.pathfinder._stopped, false);
});

test("stuck: goto hangs with no movement → stuck, pathfinder stopped", async () => {
	const bot = makeBot({ goto: NEVER });
	const m = createMotionService(bot);
	const r = await m.gotoSafe({}, { timeoutMs: 5000, stuckWindowMs: 60, pollMs: 10, graceMs: 0, stuckDelta: 1 });
	assert.equal(r.ok, false);
	assert.equal(r.code, "stuck");
	assert.equal(bot.pathfinder._stopped, true);
});

test("nopath: path_update status noPath → nopath", async () => {
	const bot = makeBot({ goto: NEVER });
	const m = createMotionService(bot);
	const p = m.gotoSafe({}, { timeoutMs: 5000, stuckWindowMs: 5000, pollMs: 1000, graceMs: 5000 });
	setTimeout(() => bot.emit("path_update", { status: "noPath" }), 20);
	const r = await p;
	assert.equal(r.code, "nopath");
	assert.equal(bot.pathfinder._stopped, true);
});

test("timeout: goto hangs, wall-clock fires before watchdog", async () => {
	const bot = makeBot({ goto: NEVER });
	const m = createMotionService(bot);
	const r = await m.gotoSafe({}, { timeoutMs: 40, stuckWindowMs: 10000, pollMs: 1000, graceMs: 10000 });
	assert.equal(r.code, "timeout");
});

test("goal_changed: goto rejection is classified, not treated as reached", async () => {
	const bot = makeBot({
		goto: () => Promise.reject(new Error("GoalChanged: The goal was changed before it could be completed")),
	});
	const m = createMotionService(bot);
	const r = await m.gotoSafe({}, { timeoutMs: 1000, stuckWindowMs: 1000, pollMs: 50, graceMs: 1000 });
	assert.equal(r.ok, false);
	assert.equal(r.code, "goal_changed");
});

test("progress resets the stuck window", async () => {
	const bot = makeBot({ goto: NEVER });
	const m = createMotionService(bot);
	// Move the bot forward steadily so the watchdog never trips before timeout.
	const mover = setInterval(() => { bot.entity.position.x += 5; }, 15);
	const r = await m.gotoSafe({}, { timeoutMs: 120, stuckWindowMs: 80, pollMs: 10, graceMs: 0, stuckDelta: 1 });
	clearInterval(mover);
	// It kept moving, so it should hit the wall-clock timeout, not "stuck".
	assert.equal(r.code, "timeout");
	assert.ok(r.movedBlocks > 0, `expected movedBlocks>0, got ${r.movedBlocks}`);
});

test("classifyGotoError maps messages to stable codes", () => {
	assert.equal(classifyGotoError(new Error("GoalChanged")), "goal_changed");
	assert.equal(classifyGotoError(new Error("Took too long to compute path")), "timeout");
	assert.equal(classifyGotoError(new Error("No path to the goal!")), "nopath");
	assert.equal(classifyGotoError(new Error("something else")), "error");
});

test("hdist is horizontal only", () => {
	assert.equal(_internal.hdist({ x: 0, y: 0, z: 0 }, { x: 3, y: 100, z: 4 }), 5);
});
