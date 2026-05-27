// Event-driven awareness. The reflex used to be polling-only: every
// DISPATCH_INTERVAL_MS the loop took a snapshot and decided what to do.
// That means anything happening *between* ticks — a creeper spawning,
// the bot taking damage, the bot being teleported by a falling block —
// was invisible until the next tick, and any active skill kept running
// against stale assumptions.
//
// This module wires direct mineflayer listeners that update a small
// flags object the reflex can consume each tick AND that triggers
// "preempt" callbacks (registered by the dispatcher) when something
// significant happens. The skill currently in flight can react by
// observing ctx.abortSignal.aborted between awaits.

import { info } from "../log.js";

const HOSTILE_NAMES = new Set([
	"zombie", "skeleton", "creeper", "spider", "cave_spider", "witch",
	"husk", "stray", "drowned", "phantom", "blaze", "ghast", "magma_cube",
	"pillager", "vindicator", "vex", "wither_skeleton", "wither", "ravager",
	"enderman", "endermite", "guardian", "elder_guardian", "evoker", "silverfish",
	"hoglin", "zoglin", "piglin", "piglin_brute", "shulker", "warden",
]);

// Heuristic thresholds — tunable later.
const FORCED_MOVE_BLOCKS = 5;     // single tick movement > this = forced (teleport/fall/push)
const HEALTH_PLUNGE_DELTA = 2;    // HP dropped by ≥ this in one tick = take note
const HOSTILE_CLOSE_BLOCKS = 12;  // entity spawning within = preempt
const BLOCK_UPDATE_RADIUS = 4;    // blockUpdate within manhattan = env-changed
const ENV_CHANGE_THROTTLE_MS = 800;

export function attachAwareness(bot, { onPreempt = null } = {}) {
	if (!bot || typeof bot.on !== "function") {
		throw new Error("attachAwareness: bot.on missing");
	}
	const state = createAwarenessState();
	let lastPos = bot.entity?.position ? cloneVec(bot.entity.position) : null;
	let lastHealth = typeof bot.health === "number" ? bot.health : null;
	let lastEnvChangeAt = 0;

	function preempt(reason, payload) {
		try { onPreempt?.({ reason, payload, at: Date.now() }); } catch (e) {
			info("awareness", `preempt callback threw: ${e?.message ?? e}`);
		}
	}

	bot.on("move", () => {
		const pos = bot.entity?.position;
		if (!pos) return;
		const cur = cloneVec(pos);
		if (lastPos) {
			const dist = Math.hypot(cur.x - lastPos.x, cur.y - lastPos.y, cur.z - lastPos.z);
			if (dist >= FORCED_MOVE_BLOCKS) {
				state.flags.forcedMove = { at: Date.now(), from: lastPos, to: cur, distance: Math.round(dist * 10) / 10 };
				info("awareness", `forced move: ${state.flags.forcedMove.distance}b from (${Math.round(lastPos.x)}, ${Math.round(lastPos.y)}, ${Math.round(lastPos.z)}) to (${Math.round(cur.x)}, ${Math.round(cur.y)}, ${Math.round(cur.z)})`);
				preempt("forced_move", state.flags.forcedMove);
			}
		}
		lastPos = cur;
	});

	bot.on("health", () => {
		const hp = bot.health;
		if (typeof hp !== "number") return;
		if (lastHealth !== null && hp + HEALTH_PLUNGE_DELTA <= lastHealth) {
			state.flags.healthPlunge = { at: Date.now(), from: lastHealth, to: hp, delta: lastHealth - hp };
			info("awareness", `hp plunge: ${lastHealth} → ${hp}`);
			preempt("health_plunge", state.flags.healthPlunge);
		}
		lastHealth = hp;
	});

	bot.on("entitySpawn", (entity) => {
		if (!entity) return;
		const name = (entity.name ?? "").toLowerCase();
		if (!HOSTILE_NAMES.has(name)) return;
		const me = bot.entity?.position;
		if (!me || !entity.position) return;
		const dist = me.distanceTo(entity.position);
		if (dist > HOSTILE_CLOSE_BLOCKS) return;
		state.flags.hostileAdded = { at: Date.now(), name, distance: Math.round(dist * 10) / 10 };
		info("awareness", `hostile near: ${name}@${state.flags.hostileAdded.distance}m`);
		preempt("hostile_added", state.flags.hostileAdded);
	});

	bot.on("blockUpdate", (oldBlock, newBlock) => {
		const me = bot.entity?.position;
		if (!me) return;
		const block = newBlock ?? oldBlock;
		const at = block?.position;
		if (!at) return;
		const manhattan = Math.abs(at.x - me.x) + Math.abs(at.y - me.y) + Math.abs(at.z - me.z);
		if (manhattan > BLOCK_UPDATE_RADIUS) return;
		const now = Date.now();
		if (now - lastEnvChangeAt < ENV_CHANGE_THROTTLE_MS) return;
		lastEnvChangeAt = now;
		state.flags.envChanged = { at: now, blockName: block?.name ?? "?", distance: manhattan };
		// envChanged is informational only — does NOT trigger preempt by
		// default (block updates are too frequent during gather skills).
	});

	state._teardown = () => {
		// node:events doesn't expose direct unbind without storing refs.
		// In tests we just drop the bot. Real reflex never detaches.
	};

	info("awareness", "attached (forced_move + health_plunge + hostile_added + env_changed)");
	return state;
}

export function createAwarenessState() {
	return {
		flags: {
			forcedMove: null,
			healthPlunge: null,
			hostileAdded: null,
			envChanged: null,
		},
		consume() {
			const out = { ...this.flags };
			this.flags = {
				forcedMove: null,
				healthPlunge: null,
				hostileAdded: null,
				envChanged: null,
			};
			return out;
		},
		hasPreempting() {
			const f = this.flags;
			return !!(f.forcedMove || f.healthPlunge || f.hostileAdded);
		},
	};
}

function cloneVec(v) {
	return { x: v.x, y: v.y, z: v.z };
}

// Test exports
export const __testing = {
	HOSTILE_NAMES, FORCED_MOVE_BLOCKS, HEALTH_PLUNGE_DELTA,
	HOSTILE_CLOSE_BLOCKS, BLOCK_UPDATE_RADIUS, ENV_CHANGE_THROTTLE_MS,
};
