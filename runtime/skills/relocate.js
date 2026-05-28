// village.relocate — commit-and-walk skill that breaks the bot out of
// "I've been wandering the same 50×50 area for 2 hours" failure mode.
//
// Heuristic: when the wedge-detector says we're stuck, this skill is
// dispatched with no biome preference; it picks the least-recently-
// visited cardinal (or any cardinal if no history) and walks ~300
// blocks toward it, with a hard time budget. While it runs, the
// reflex's wedge-detector knows a relocation is in flight and won't
// fire another one on top.
//
// The skill ignores the active need entirely for its duration — its
// only job is to displace the bot far enough that the surrounding
// biome is fresh and skills like survive.acquire-food / gather.logs
// have new local context to work with.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;

import { info } from "../log.js";
import { markRelocationStarted } from "../awareness/wedge-detector.js";
import { blindWalkOrTunnelOut } from "./explore-far.js";

const CARDINALS = [
	{ name: "N", dx: 0, dz: -1, yaw: Math.PI },
	{ name: "E", dx: 1, dz: 0, yaw: -Math.PI / 2 },
	{ name: "S", dx: 0, dz: 1, yaw: 0 },
	{ name: "W", dx: -1, dz: 0, yaw: Math.PI / 2 },
];
const DEFAULT_DISTANCE = 300;
const STEP_BLOCKS = 32;            // re-path every N blocks for liveness
const STEP_TIMEOUT_MS = 30_000;

let pluginLoaded = new WeakSet();
function ensurePathfinder(bot) {
	if (pluginLoaded.has(bot)) return;
	bot.loadPlugin(pathfinder);
	pluginLoaded.add(bot);
}
function setMovementsForTravel(bot) {
	const m = new Movements(bot);
	m.canDig = true;
	m.allow1by1towers = false;
	bot.pathfinder.setMovements(m);
}

function pickCardinal(ctx, args) {
	// Explicit override wins
	if (args?.heading) {
		const found = CARDINALS.find((c) => c.name === args.heading);
		if (found) return found;
	}
	// Otherwise pick a cardinal not recently used. ctx may carry a
	// recentRelocations array {name, ts}; default = N.
	const recent = new Set((ctx?.recentRelocations ?? []).map((r) => r.name));
	const untried = CARDINALS.filter((c) => !recent.has(c.name));
	return untried[0] ?? CARDINALS[Math.floor(Math.random() * CARDINALS.length)];
}

export const skill = Object.freeze({
	id: "village.relocate",
	title: "Walk 300 blocks in a fresh cardinal to break a wedge",
	timeoutMs: 180_000,
	preconditions(ctx) {
		if (!ctx?.bot?.entity?.position) {
			return { ok: false, code: "no_bot", detail: "bot or entity missing" };
		}
		return { ok: true };
	},
	async execute(ctx, args = {}) {
		const bot = ctx.bot;
		const distance = Math.max(64, Math.min(args?.distance ?? DEFAULT_DISTANCE, 600));
		const cardinal = pickCardinal(ctx, args);
		const start = { x: bot.entity.position.x, z: bot.entity.position.z };
		markRelocationStarted({ x: start.x, z: start.z, heading: cardinal });
		ctx.recentRelocations = (ctx.recentRelocations ?? []).slice(-3);
		ctx.recentRelocations.push({ name: cardinal.name, ts: Date.now() });

		ensurePathfinder(bot);
		setMovementsForTravel(bot);
		info("action", `relocate: heading ${cardinal.name} for ${distance}b from (${Math.round(start.x)}, ${Math.round(start.z)})`);

		let travelled = 0;
		const errors = [];
		while (travelled < distance) {
			if (ctx?.abortSignal?.aborted) {
				return {
					ok: travelled >= distance / 2, // partial counts if we got at least half
					code: travelled >= distance / 2 ? "partial" : "preempted",
					detail: { travelled: Math.round(travelled), heading: cardinal.name },
					worldDelta: { moved: Math.round(travelled), heading: cardinal.name },
				};
			}
			const stepDist = Math.min(STEP_BLOCKS, distance - travelled);
			const targetX = start.x + cardinal.dx * (travelled + stepDist);
			const targetZ = start.z + cardinal.dz * (travelled + stepDist);
			const targetY = Math.floor(bot.entity.position.y);
			try {
				await Promise.race([
					bot.pathfinder.goto(new goals.GoalNear(Math.floor(targetX), targetY, Math.floor(targetZ), 4)),
					new Promise((_, rej) => setTimeout(() => rej(new Error("step timeout")), STEP_TIMEOUT_MS)),
				]);
			} catch (e) {
				errors.push(e?.message ?? String(e));
				info("action", `relocate: path step failed (${e?.message ?? e}); blind fallback ${cardinal.name}`);
				const blind = await blindWalkOrTunnelOut(bot, {
					yaw: cardinal.yaw,
					dirName: cardinal.name,
					blindMs: 12_000,
					minMove: 8,
					reason: `relocate ${cardinal.name}`,
				});
				if (!blind.ok && errors.length >= 3) break;
			}
			// Measure actual progress (pathfinder might have routed around)
			const dx = bot.entity.position.x - start.x;
			const dz = bot.entity.position.z - start.z;
			travelled = Math.hypot(dx, dz);
		}

		const endPos = bot.entity.position;
		const finalDist = Math.hypot(endPos.x - start.x, endPos.z - start.z);
		if (finalDist < 50) {
			return {
				ok: false,
				code: "stuck_in_place",
				detail: { travelled: Math.round(finalDist), heading: cardinal.name, errors: errors.slice(0, 3) },
				worldDelta: { moved: Math.round(finalDist) },
			};
		}
		return {
			ok: true,
			code: "done",
			detail: { travelled: Math.round(finalDist), heading: cardinal.name },
			worldDelta: { moved: Math.round(finalDist), heading: cardinal.name, mode: "relocate" },
		};
	},
	recover(ctx, result) {
		if (result.code === "stuck_in_place") {
			return { hint: "wander", reason: "relocate could not gain ground; let wander try a new tactic" };
		}
		return null;
	},
});

// Test exports
export const __testing = { CARDINALS, DEFAULT_DISTANCE, pickCardinal };
