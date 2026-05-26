// explore.far — walk ~48 blocks in a single direction, away from where
// the bot currently stands. Used as the wander hint target when
// gather.* skills can't find their resource in the bot's immediate
// neighbourhood (e.g. spawn protection with no trees inside 64 blocks).
//
// Picks a heading by quadrant rotation (NE → SE → SW → NW) so successive
// calls actually circle the spawn instead of bouncing within the same
// patch.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;

import { info, warn } from "../log.js";

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

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Per-bot quadrant rotation.
const quadrantOf = new WeakMap();
const QUADRANTS = [
	{ x: +1, z: -1 }, // NE
	{ x: +1, z: +1 }, // SE
	{ x: -1, z: +1 }, // SW
	{ x: -1, z: -1 }, // NW
];

function nextQuadrant(bot) {
	const idx = (quadrantOf.get(bot) ?? -1) + 1;
	quadrantOf.set(bot, idx);
	return QUADRANTS[idx % QUADRANTS.length];
}

export const skill = Object.freeze({
	id: "explore.far",
	title: "Walk ~48 blocks in one direction",
	timeoutMs: 90_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		return { ok: true };
	},
	async execute(ctx, args = {}) {
		const bot = ctx.bot;
		ensurePathfinder(bot);
		setMovementsForTravel(bot);

		// 2026-05-26: probe-then-go. Try all 4 cardinal directions for
		// 800 ms each, pick the one where we actually moved, then commit
		// a long blind walk in that direction. Pathfinder timeouts on
		// this server mean we can't trust GoalNear; cardinal probing
		// gives us a free-direction signal cheaply.
		const dist = Math.max(24, args.distance ?? 48);
		const trials = await probeCardinalStep(bot, 800);
		const best = trials.reduce((b, t) => (t.dist > b.dist ? t : b), { dist: 0, yaw: 0, name: "?" });
		info("action", `explore.far: cardinal probe trials=${trials.map((t) => `${t.name}:${t.dist.toFixed(1)}`).join(" ")} best=${best.name}`);

		if (best.dist < 0.5) {
			// All cardinals blocked. Same wedged-jump as wander.
			info("action", "explore.far: wedged — jump fallback");
			try { await bot.look(best.yaw ?? 0, 0, true); } catch {}
			bot.setControlState("forward", true);
			bot.setControlState("jump", true);
			try {
				await new Promise((r) => setTimeout(r, 3_000));
			} finally {
				bot.setControlState("forward", false);
				bot.setControlState("jump", false);
			}
			return { ok: true, code: "done", detail: { mode: "wedged-jump", trials }, worldDelta: { movedTo: null } };
		}

		const here = bot.entity.position.clone();
		const tx = Math.round(here.x + Math.sin(-best.yaw) * dist);
		const tz = Math.round(here.z + Math.cos(-best.yaw) * dist);
		const ty = Math.round(here.y);
		info("action", `explore.far: walking ${best.name} → ${tx},${ty},${tz}`);

		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 4)),
				45_000,
				`explore.far(${tx},${tz})`,
			);
			return {
				ok: true, code: "done",
				detail: { to: { x: tx, y: ty, z: tz }, dir: best.name },
				worldDelta: { movedTo: { x: tx, y: ty, z: tz } },
			};
		} catch (e) {
			warn("action", `explore.far pathfinder failed: ${e.message} — continuing blind`);
			try { await bot.look(best.yaw, 0, true); } catch {}
			bot.setControlState("forward", true);
			bot.setControlState("jump", true);
			try {
				await new Promise((r) => setTimeout(r, 7_000));
			} finally {
				bot.setControlState("forward", false);
				bot.setControlState("jump", false);
			}
			return {
				ok: true, code: "done",
				detail: { mode: "blind", dir: best.name },
				worldDelta: { movedTo: null },
			};
		}
	},
});

const CARDINAL_YAWS = [
	{ name: "N", yaw: Math.PI },
	{ name: "E", yaw: -Math.PI / 2 },
	{ name: "S", yaw: 0 },
	{ name: "W", yaw: Math.PI / 2 },
];

async function probeCardinalStep(bot, durationMs = 800) {
	const trials = [];
	for (const { name, yaw } of CARDINAL_YAWS) {
		try { await bot.look(yaw, 0, true); } catch {}
		const before = bot.entity.position.clone();
		bot.setControlState("forward", true);
		try {
			await new Promise((r) => setTimeout(r, durationMs));
		} finally {
			bot.setControlState("forward", false);
		}
		const after = bot.entity.position;
		const dist = Math.hypot(after.x - before.x, after.z - before.z);
		trials.push({ name, yaw, dist });
		await new Promise((r) => setTimeout(r, 150));
	}
	return trials;
}
