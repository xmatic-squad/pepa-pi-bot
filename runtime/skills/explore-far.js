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

		const here = bot.entity.position;
		const dist = Math.max(24, args.distance ?? 48);
		const q = args.quadrant ?? nextQuadrant(bot);
		const tx = Math.round(here.x + q.x * dist);
		const tz = Math.round(here.z + q.z * dist);
		const ty = Math.round(here.y);
		info("action", `explore.far: → ${tx},${ty},${tz} (quad=${q.x},${q.z}, dist=${dist})`);

		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 4)),
				60_000,
				`explore.far(${tx},${tz})`,
			);
			return {
				ok: true,
				code: "done",
				detail: { to: { x: tx, y: ty, z: tz }, quadrant: q },
				worldDelta: { movedTo: { x: tx, y: ty, z: tz } },
			};
		} catch (e) {
			warn("action", `explore.far failed: ${e.message} — blind walking`);
			try {
				const dx = tx - here.x;
				const dz = tz - here.z;
				const yaw = Math.atan2(-dx, -dz);
				await bot.look(yaw, 0, true);
				bot.setControlState("forward", true);
				bot.setControlState("jump", true);
				await new Promise((r) => setTimeout(r, 5_000));
				bot.setControlState("forward", false);
				bot.setControlState("jump", false);
				return {
					ok: true,
					code: "done",
					detail: { mode: "blind", quadrant: q },
					worldDelta: { movedTo: null },
				};
			} catch (e2) {
				bot.setControlState("forward", false);
				bot.setControlState("jump", false);
				return { ok: false, code: "failed", detail: `${e.message}; blind ${e2.message}`, worldDelta: null };
			}
		}
	},
});
