import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { attachAwareness, createAwarenessState, __testing } from "./events.js";

function vec(x, y, z) {
	return {
		x, y, z,
		distanceTo(other) {
			return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
		},
	};
}

function makeBot(pos = vec(0, 64, 0), hp = 20) {
	const bot = new EventEmitter();
	bot.entity = { position: pos };
	bot.health = hp;
	return bot;
}

test("attachAwareness: throws when bot has no on()", () => {
	assert.throws(() => attachAwareness({}), /bot\.on missing/);
});

test("createAwarenessState: starts with null flags, consume resets", () => {
	const s = createAwarenessState();
	assert.equal(s.flags.forcedMove, null);
	s.flags.forcedMove = { at: 1, from: {}, to: {}, distance: 7 };
	assert.equal(s.hasPreempting(), true);
	const out = s.consume();
	assert.equal(out.forcedMove.distance, 7);
	assert.equal(s.flags.forcedMove, null);
});

test("forcedMove: jump > threshold flags + preempts", () => {
	const calls = [];
	const bot = makeBot(vec(0, 64, 0));
	const state = attachAwareness(bot, { onPreempt: (e) => calls.push(e) });
	// move within threshold — no flag
	bot.entity.position = vec(1, 64, 0);
	bot.emit("move");
	assert.equal(state.flags.forcedMove, null);
	assert.equal(calls.length, 0);
	// teleport / fall — far jump
	bot.entity.position = vec(20, 64, 0);
	bot.emit("move");
	assert.ok(state.flags.forcedMove, "forcedMove flag set");
	assert.ok(state.flags.forcedMove.distance >= 18);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].reason, "forced_move");
});

test("healthPlunge: HP drop ≥ delta flags + preempts", () => {
	const calls = [];
	const bot = makeBot(vec(0, 64, 0), 20);
	const state = attachAwareness(bot, { onPreempt: (e) => calls.push(e) });
	// trivial HP change does NOT flag
	bot.health = 19;
	bot.emit("health");
	assert.equal(state.flags.healthPlunge, null);
	// big drop
	bot.health = 12;
	bot.emit("health");
	assert.ok(state.flags.healthPlunge);
	assert.equal(state.flags.healthPlunge.from, 19);
	assert.equal(state.flags.healthPlunge.to, 12);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].reason, "health_plunge");
});

test("hostileAdded: zombie nearby triggers preempt", () => {
	const calls = [];
	const bot = makeBot();
	const state = attachAwareness(bot, { onPreempt: (e) => calls.push(e) });
	const zombie = { name: "zombie", position: vec(2, 64, 0) };
	bot.emit("entitySpawn", zombie);
	assert.ok(state.flags.hostileAdded);
	assert.equal(state.flags.hostileAdded.name, "zombie");
	assert.equal(state.flags.hostileAdded.distance, 2);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].reason, "hostile_added");
});

test("hostileAdded: far hostile ignored", () => {
	const bot = makeBot();
	const state = attachAwareness(bot);
	const far = { name: "creeper", position: vec(50, 64, 0) };
	bot.emit("entitySpawn", far);
	assert.equal(state.flags.hostileAdded, null);
});

test("hostileAdded: passive mob ignored", () => {
	const bot = makeBot();
	const state = attachAwareness(bot);
	const cow = { name: "cow", position: vec(2, 64, 0) };
	bot.emit("entitySpawn", cow);
	assert.equal(state.flags.hostileAdded, null);
});

test("envChanged: nearby blockUpdate flags but does NOT preempt", () => {
	const calls = [];
	const bot = makeBot();
	const state = attachAwareness(bot, { onPreempt: (e) => calls.push(e) });
	const newBlock = { name: "cobblestone", position: vec(1, 64, 0) };
	bot.emit("blockUpdate", null, newBlock);
	assert.ok(state.flags.envChanged);
	assert.equal(state.flags.envChanged.blockName, "cobblestone");
	assert.equal(calls.length, 0, "env changes are observational, not preempting");
});

test("envChanged: throttled", () => {
	const bot = makeBot();
	const state = attachAwareness(bot);
	const near = { name: "stone", position: vec(2, 64, 0) };
	bot.emit("blockUpdate", null, near);
	const firstAt = state.flags.envChanged.at;
	bot.emit("blockUpdate", null, near);
	// second one within throttle window keeps the first timestamp
	assert.equal(state.flags.envChanged.at, firstAt);
});

test("envChanged: far blockUpdate ignored", () => {
	const bot = makeBot();
	const state = attachAwareness(bot);
	const far = { name: "stone", position: vec(20, 64, 0) };
	bot.emit("blockUpdate", null, far);
	assert.equal(state.flags.envChanged, null);
});

test("hasPreempting: true only for forcedMove/healthPlunge/hostileAdded", () => {
	const s = createAwarenessState();
	assert.equal(s.hasPreempting(), false);
	s.flags.envChanged = { at: 1, blockName: "stone", distance: 2 };
	assert.equal(s.hasPreempting(), false, "envChanged alone does not preempt");
	s.flags.hostileAdded = { at: 1, name: "creeper", distance: 5 };
	assert.equal(s.hasPreempting(), true);
});

test("thresholds: constants are sane", () => {
	assert.ok(__testing.FORCED_MOVE_BLOCKS >= 3 && __testing.FORCED_MOVE_BLOCKS <= 10);
	assert.ok(__testing.HEALTH_PLUNGE_DELTA >= 1 && __testing.HEALTH_PLUNGE_DELTA <= 5);
	assert.ok(__testing.HOSTILE_CLOSE_BLOCKS >= 8);
});
