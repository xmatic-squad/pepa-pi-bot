// MotionService (L1 service) — gotoSafe(): pathfinding that cannot hang silently.
//
// mineflayer-pathfinder has three documented failure modes that leak into the
// planner as "false success / silent hang" (research §B):
//   - #222: obstructed by an unbreakable block → bot stops, NO error, NO
//     goal_reached / path_update / path_reset event. goto() never settles.
//   - #273: AStar returns a partial path → monitorMovements returns early.
//   - #341: GoalLookAtBlock raycasts collision boxes only → never "reached".
//
// gotoSafe wraps bot.pathfinder.goto with three independent kill-switches and
// returns a STRUCTURED result the caller can branch on instead of awaiting a
// promise that may never resolve:
//   { ok: true,  code: "reached",  movedBlocks }
//   { ok: false, code: "stuck",    movedBlocks }   // progress watchdog
//   { ok: false, code: "timeout",  movedBlocks }   // wall-clock OR pf compute
//   { ok: false, code: "nopath",   movedBlocks }   // path_update status noPath
//   { ok: false, code: "goal_changed" | "error", movedBlocks }
//
// On any non-reached outcome it calls bot.pathfinder.stop() so the caller is
// free to fall back (blind walk, dig-in, relocate) without two controllers
// fighting over the same goal.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder } = pathfinderPkg;

import { info, warn } from "../log.js";

function hdist(a, b) {
	if (!a || !b) return Number.POSITIVE_INFINITY;
	return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0));
}

function clonePos(p) {
	return p ? { x: p.x, y: p.y, z: p.z } : null;
}

function round1(n) {
	return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

// Classify a goto() rejection into a stable code.
export function classifyGotoError(err) {
	const msg = (err?.message ?? String(err ?? "")).toLowerCase();
	if (msg.includes("goalchanged") || msg.includes("goal was changed")) return "goal_changed";
	if (msg.includes("took too long") || msg.includes("timed out") || msg.includes("timeout")) return "timeout";
	if (msg.includes("no path") || msg.includes("nopath")) return "nopath";
	return "error";
}

function ensurePathfinder(bot) {
	// A real bot needs the plugin loaded once; a fake bot in tests already
	// carries a stub `pathfinder`, so we only load when it is absent.
	if (bot?.pathfinder) return;
	try {
		bot.loadPlugin(pathfinder);
	} catch (e) {
		warn("motion", `loadPlugin failed: ${e?.message ?? e}`);
	}
}

export function createMotionService(bot, defaults = {}) {
	if (!bot) throw new Error("motion: bot required");
	ensurePathfinder(bot);

	async function gotoSafe(goal, opts = {}) {
		const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs ?? 30_000;
		const stuckWindowMs = opts.stuckWindowMs ?? defaults.stuckWindowMs ?? 8_000;
		const stuckDelta = opts.stuckDelta ?? defaults.stuckDelta ?? 1.0;
		const pollMs = opts.pollMs ?? defaults.pollMs ?? 1_000;
		const graceMs = opts.graceMs ?? defaults.graceMs ?? 1_500;
		const label = opts.label ?? "gotoSafe";

		const startPos = clonePos(bot.entity?.position);
		let lastProgressPos = startPos;
		let lastProgressAt = Date.now();
		const startedAt = lastProgressAt;

		let settled = false;
		let outcome = null;
		let watchTimer = null;
		let wallTimer = null;
		let onPathUpdate = null;

		const movedSoFar = () => hdist(startPos, bot.entity?.position);

		function cleanup() {
			if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
			if (wallTimer) { clearTimeout(wallTimer); wallTimer = null; }
			if (onPathUpdate) {
				try { bot.removeListener?.("path_update", onPathUpdate); } catch {}
				onPathUpdate = null;
			}
		}

		function finalize(result) {
			if (settled) return outcome;
			settled = true;
			outcome = { ...result, movedBlocks: round1(movedSoFar()) };
			if (!result.ok) {
				try { bot.pathfinder?.stop?.(); } catch {}
			}
			cleanup();
			return outcome;
		}

		const gotoP = Promise.resolve()
			.then(() => bot.pathfinder.goto(goal))
			.then(
				() => finalize({ ok: true, code: "reached", detail: null }),
				(err) => finalize({ ok: false, code: classifyGotoError(err), detail: err?.message ?? String(err) }),
			);

		const earlyExit = new Promise((resolve) => {
			onPathUpdate = (res) => {
				const status = res?.status;
				if (status === "noPath") {
					resolve(finalize({ ok: false, code: "nopath", detail: "pathfinder: noPath" }));
				} else if (status === "timeout") {
					resolve(finalize({ ok: false, code: "timeout", detail: "pathfinder: compute timeout" }));
				}
			};
			try { bot.on?.("path_update", onPathUpdate); } catch {}

			watchTimer = setInterval(() => {
				if (settled) return;
				const now = Date.now();
				if (now - startedAt < graceMs) return;
				const here = bot.entity?.position;
				if (hdist(lastProgressPos, here) >= stuckDelta) {
					lastProgressPos = clonePos(here);
					lastProgressAt = now;
					return;
				}
				if (now - lastProgressAt >= stuckWindowMs) {
					resolve(finalize({
						ok: false,
						code: "stuck",
						detail: `no progress for ${Math.round((now - lastProgressAt) / 1000)}s`,
					}));
				}
			}, pollMs);
		});

		const wallClock = new Promise((resolve) => {
			wallTimer = setTimeout(() => {
				resolve(finalize({ ok: false, code: "timeout", detail: `${label} wall-clock ${timeoutMs}ms` }));
			}, timeoutMs);
		});

		const result = await Promise.race([gotoP, earlyExit, wallClock]);
		if (!result.ok && result.code !== "goal_changed") {
			info("motion", `${label} → ${result.code} (moved ${result.movedBlocks}b)`);
		}
		return result;
	}

	return { gotoSafe };
}

export const _internal = { hdist, classifyGotoError, clonePos, round1 };
