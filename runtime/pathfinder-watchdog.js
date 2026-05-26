// Pathfinder stuck-watchdog.
//
// Problem (observed live 2026-05-26): mineflayer-pathfinder computes a
// path once when goto() is called and does NOT recompute when the
// world changes mid-traversal. If a player places a block in front of
// the bot — or a creeper craters the path — pathfinder keeps trying to
// step into the old node and the bot just stands there pressing forward
// against the new obstacle until the goto() timeout (typically 30–60 s).
//
// Fix: a poll loop that runs while `bot.pathfinder.goal` is non-null.
// Every WATCH_INTERVAL_MS we read the horizontal position. If we haven't
// moved STUCK_DELTA blocks in STUCK_WINDOW_MS, we declare the path
// stale and force a replan by clearing the goal and re-setting it. The
// pathfinder then recomputes against the current world, taking the new
// obstacle into account — including digging through it if canDig=true.
//
// Side benefit: even when no obstacle was placed, this catches the
// pathological "pathfinder stuck on a goal it can never reach" case
// (mineflayer-pathfinder issue #222) much earlier than the 45 s goto
// timeout we wrapped goto() in.

import { info, warn } from "./log.js";

const WATCH_INTERVAL_MS = 2_000;
const STUCK_WINDOW_MS = 6_000;
const STUCK_DELTA = 0.5;
const MIN_TRAVEL_TIME_MS = 1_500; // grace at the start so we don't replan during initial step
const MAX_REPLAN_PER_GOAL = 3;

function hpos(p) {
	return p ? { x: p.x, z: p.z } : null;
}
function hdist(a, b) {
	if (!a || !b) return Number.POSITIVE_INFINITY;
	return Math.hypot(a.x - b.x, a.z - b.z);
}

export function createPathfinderWatchdog(bot, {
	intervalMs = WATCH_INTERVAL_MS,
	windowMs = STUCK_WINDOW_MS,
	delta = STUCK_DELTA,
	maxReplans = MAX_REPLAN_PER_GOAL,
} = {}) {
	if (!bot) throw new Error("pathfinder-watchdog: bot required");
	let lastSeenAt = 0;
	let lastSeenPos = null;
	let lastGoal = null;
	let goalStartedAt = 0;
	let replansThisGoal = 0;
	let stopped = false;
	let timer = null;

	function tick() {
		if (stopped) return;
		const pf = bot.pathfinder;
		const goal = pf?.goal;
		if (!goal) {
			// No active goal — reset our state.
			lastGoal = null;
			lastSeenPos = null;
			replansThisGoal = 0;
			return;
		}
		if (goal !== lastGoal) {
			// New goal started — reset counters.
			lastGoal = goal;
			lastSeenPos = hpos(bot.entity?.position);
			lastSeenAt = Date.now();
			goalStartedAt = Date.now();
			replansThisGoal = 0;
			return;
		}
		if (Date.now() - goalStartedAt < MIN_TRAVEL_TIME_MS) return;

		const now = Date.now();
		const here = hpos(bot.entity?.position);
		if (here && hdist(here, lastSeenPos) >= delta) {
			lastSeenPos = here;
			lastSeenAt = now;
			return;
		}
		if (now - lastSeenAt < windowMs) return;

		// Stuck. Force a replan — clear the goal, then re-set the same
		// goal so pathfinder rebuilds the graph against the current world.
		if (replansThisGoal >= maxReplans) {
			warn("pathfinder", `stuck > ${windowMs / 1000}s and hit ${maxReplans} replans; giving up — caller's timeout will fire`);
			lastSeenAt = now; // throttle further warnings within this window
			return;
		}
		replansThisGoal++;
		info("pathfinder", `stuck for ${Math.round((now - lastSeenAt) / 1000)}s at (${Math.round(here?.x ?? 0)},${Math.round(here?.z ?? 0)}) — forcing replan #${replansThisGoal}`);
		try {
			const goalCopy = goal;
			// setGoal(null) cancels the current pathing without bubbling
			// an error to the awaiting goto() promise.
			pf.setGoal(null);
			// Re-set immediately. mineflayer-pathfinder will compute a
			// fresh path off the latest world snapshot.
			setTimeout(() => {
				if (stopped) return;
				try { pf.setGoal(goalCopy); } catch (e) { warn("pathfinder", `replan setGoal failed: ${e.message}`); }
			}, 250);
			lastSeenAt = now; // reset window
		} catch (e) {
			warn("pathfinder", `replan failed: ${e.message}`);
		}
	}

	timer = setInterval(tick, intervalMs);
	return {
		stop() {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = null;
		},
	};
}

// Pure helpers for tests.
export const _internal = { hpos, hdist };
