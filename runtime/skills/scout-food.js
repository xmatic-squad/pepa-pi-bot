// survive.scout-food — longer-range, biome-aware food search.
//
// Why this exists alongside survive.acquire-food:
//
// acquire-food is the "I see a cow, hunt it" skill. Its precondition
// requires a passive food mob within ~32 blocks; if there isn't one,
// the skill bails immediately. In v0.3.0 that produced two failure
// modes that kept the bot looping for hours:
//
//   1. Biome with NO passive mobs (desert, ocean, snowy peaks, deep
//      caves). acquire-food can never succeed there — the bot just
//      kept scanning the same 32-block sphere.
//
//   2. Biome WITH passive mobs but the immediate area is empty. The
//      bot wandered 1-8 blocks at a time around the same 50×50 patch
//      and never committed to a direction long enough to leave it.
//
// scout-food applies the "commit-to-cardinal" pattern (per the v0.3.1
// design research): scan(32) → patrol(64, time-budget) → if still
// nothing, walk a chosen cardinal for ~200 blocks, rescanning every
// 16 blocks. On exhaustion of all 4 cardinals it surrenders to the
// curriculum so the operator-driven `village.relocate` or LLM advisor
// can pick up.
//
// Biome-awareness:
// - If current biome's affordance table has has_passive_mobs=false
//   AND has_water=false, skip the local scan entirely and pick the
//   most plausible "leave biome" heading: sample neighbour biomes at
//   radius 64 in 8 directions, pick the first one whose affordances
//   say has_passive_mobs=true.
// - In water-bearing barren biomes (ocean shores, frozen rivers)
//   fishing isn't implemented yet — operator-facing improvement.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;

import { info, warn } from "../log.js";
import { foods } from "./groups.js";
import { affordancesFor, hasPassiveMobs, isBarren } from "../biome-affordances.js";
import { blindWalkOrTunnelOut } from "./explore-far.js";

const PASSIVE_FOOD_MOBS = new Set(["cow", "pig", "chicken", "sheep", "rabbit", "mooshroom"]);
const CARDINALS = [
	{ name: "N", dx: 0, dz: -1, yaw: Math.PI },
	{ name: "E", dx: 1, dz: 0, yaw: -Math.PI / 2 },
	{ name: "S", dx: 0, dz: 1, yaw: 0 },
	{ name: "W", dx: -1, dz: 0, yaw: Math.PI / 2 },
];
const PATROL_TICK_DISTANCE = 16;
const PATROL_STEP_TIMEOUT_MS = 12_000;
const DEFAULT_COMMIT_DISTANCE = 200;

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

function foodCount(bot) {
	const allowed = foods(bot);
	return bot.inventory.items().reduce((sum, item) => allowed.has(item.name) ? sum + item.count : sum, 0);
}

function nearestPassiveFoodMob(bot, maxDistance) {
	const here = bot?.entity?.position;
	if (!here) return null;
	let best = null;
	for (const e of Object.values(bot.entities ?? {})) {
		if (!e?.position || !PASSIVE_FOOD_MOBS.has(e.name)) continue;
		const d = e.position.distanceTo(here);
		if (d > maxDistance) continue;
		if (!best || d < best.distance) best = { entity: e, distance: d };
	}
	return best;
}

function currentBiomeName(bot) {
	try {
		const block = bot.blockAt?.(bot.entity?.position);
		const b = block?.biome;
		if (typeof b === "string") return b;
		if (b?.name) return b.name;
		return null;
	} catch { return null; }
}

function biomeNameAt(bot, x, y, z) {
	try {
		const block = bot.blockAt?.({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
		const b = block?.biome;
		if (typeof b === "string") return b;
		if (b?.name) return b.name;
		return null;
	} catch { return null; }
}

// Sample biomes in 8 compass directions at the given radius; return
// the heading whose biome has passive mobs.
function scanForFoodCapableNeighbourBiome(bot, radius = 64) {
	const here = bot?.entity?.position;
	if (!here) return null;
	const dirs = [
		{ name: "N",  dx: 0,    dz: -1   },
		{ name: "NE", dx: 0.71, dz: -0.71 },
		{ name: "E",  dx: 1,    dz: 0    },
		{ name: "SE", dx: 0.71, dz: 0.71 },
		{ name: "S",  dx: 0,    dz: 1    },
		{ name: "SW", dx: -0.71, dz: 0.71 },
		{ name: "W",  dx: -1,   dz: 0    },
		{ name: "NW", dx: -0.71, dz: -0.71 },
	];
	for (const d of dirs) {
		const b = biomeNameAt(bot, here.x + d.dx * radius, here.y, here.z + d.dz * radius);
		if (b && hasPassiveMobs(b)) return { heading: d, biome: b };
	}
	return null;
}

function scoutState(ctx, bot) {
	const here = bot?.entity?.position;
	const now = Date.now();
	const prev = ctx.scoutFoodState;
	const expired = !prev || now - (prev.ts ?? 0) > 10 * 60_000;
	const displaced = prev?.origin && here
		? Math.hypot(here.x - prev.origin.x, here.z - prev.origin.z) > 128
		: false;
	if (expired || displaced) {
		ctx.scoutFoodState = {
			ts: now,
			origin: here ? { x: here.x, z: here.z } : null,
			tried: new Set(),
		};
		return ctx.scoutFoodState;
	}
	prev.ts = now;
	if (!(prev.tried instanceof Set)) prev.tried = new Set(prev.tried ?? []);
	return prev;
}

async function patrolCardinal(bot, cardinal, distance, ctx) {
	ensurePathfinder(bot);
	setMovementsForTravel(bot);
	const start = bot.entity.position.clone?.() ?? { ...bot.entity.position };
	let travelled = 0;
	while (travelled < distance) {
		if (ctx?.abortSignal?.aborted) return { aborted: true, travelled };
		const tx = start.x + cardinal.dx * (travelled + PATROL_TICK_DISTANCE);
		const tz = start.z + cardinal.dz * (travelled + PATROL_TICK_DISTANCE);
		const goal = new goals.GoalNear(Math.floor(tx), Math.floor(bot.entity.position.y), Math.floor(tz), 2);
		try {
			await Promise.race([
				bot.pathfinder.goto(goal),
				new Promise((_, rej) => setTimeout(() => rej(new Error("patrol step timeout")), PATROL_STEP_TIMEOUT_MS)),
			]);
		} catch (e) {
			info("action", `scout-food: path step failed (${e?.message ?? e}); blind fallback ${cardinal.name}`);
			try { bot.pathfinder?.stop?.(); } catch {}
			const blind = await blindWalkOrTunnelOut(bot, {
				yaw: cardinal.yaw ?? -Math.atan2(cardinal.dx, cardinal.dz),
				dirName: cardinal.name,
				blindMs: 12_000,
				minMove: 6,
				reason: `scout-food ${cardinal.name}`,
			});
			const progress = cardinalProgress(start, bot.entity.position, cardinal);
			travelled = progress.along;
			const target = nearestPassiveFoodMob(bot, 32);
			if (target) return { aborted: false, travelled, target };
			if (progress.total >= 4 && progress.along < 4) {
				info("action", `scout-food: ${cardinal.name} blocked; drifted ${progress.driftName ?? "sideways"} ${progress.total.toFixed(1)}b`);
				return {
					aborted: false,
					travelled,
					blocked: true,
					drifted: progress.driftName,
					error: `blocked_${cardinal.name}`,
				};
			}
			if (!blind.ok && progress.total < 4) {
				return { aborted: false, travelled, error: e?.message ?? String(e) };
			}
			continue;
		}
		const progress = cardinalProgress(start, bot.entity.position, cardinal);
		travelled = Math.max(travelled + PATROL_TICK_DISTANCE, progress.along);
		// Rescan after every step.
		const target = nearestPassiveFoodMob(bot, 32);
		if (target) return { aborted: false, travelled, target };
	}
	return { aborted: false, travelled };
}

function cardinalProgress(start, pos, cardinal) {
	const dx = (pos?.x ?? 0) - (start?.x ?? 0);
	const dz = (pos?.z ?? 0) - (start?.z ?? 0);
	const along = Math.max(0, dx * cardinal.dx + dz * cardinal.dz);
	const total = Math.hypot(dx, dz);
	return { along, total, driftName: dominantCardinal(dx, dz, cardinal.name) };
}

function dominantCardinal(dx, dz, fallback = null) {
	if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return fallback;
	if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "E" : "W";
	return dz >= 0 ? "S" : "N";
}

export const skill = Object.freeze({
	id: "survive.scout-food",
	title: "Scout for food at long range (biome-aware)",
	timeoutMs: 240_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		if (foodCount(ctx.bot) > 0) {
			return { ok: false, code: "already_have", detail: "already carrying edible food" };
		}
		return { ok: true };
	},
	async execute(ctx, args = {}) {
		const bot = ctx.bot;
		const before = foodCount(bot);
		const state = scoutState(ctx, bot);
		const triedCardinals = new Set([...(args?._triedCardinals ?? []), ...(state.tried ?? [])]);

		// Step 0: biome check. If barren, head toward a food-capable neighbour.
		const biome = currentBiomeName(bot);
		const aff = affordancesFor(biome);
		info("action", `scout-food: biome=${biome ?? "?"} mobs=${aff.has_passive_mobs} barren=${isBarren(biome)}`);

		if (!aff.has_passive_mobs) {
			const next = scanForFoodCapableNeighbourBiome(bot, 64);
			if (next) {
				info("action", `scout-food: leaving barren biome ${biome} → ${next.biome} via ${next.heading.name}`);
				const result = await patrolCardinal(bot, next.heading, DEFAULT_COMMIT_DISTANCE, ctx);
		if (result.aborted) return { ok: false, code: "preempted", worldDelta: null };
		if (result.target) {
			return await tryHunt(bot, result.target, before);
		}
		if (result.blocked) {
			state.tried.add(next.heading.name);
			return {
				ok: false,
				code: "blocked_heading",
				detail: `blocked ${next.heading.name}, drifted ${result.drifted ?? "sideways"}`,
				worldDelta: { moved: Math.round(result.travelled), heading: next.heading.name, drifted: result.drifted ?? null },
			};
		}
		return {
			ok: false,
			code: "no_target",
			detail: `walked ${Math.round(result.travelled)}b ${next.heading.name} toward ${next.biome}, still no food`,
					worldDelta: { moved: Math.round(result.travelled), heading: next.heading.name, from_biome: biome, to_biome: next.biome },
				};
			}
			// Ringed by barren biomes; pick the first cardinal not yet tried.
		}

		// Step 1: scan radius 32 (cheap).
		let target = nearestPassiveFoodMob(bot, 32);
		if (target) return await tryHunt(bot, target, before);

		// Step 2: scan radius 64 — entities frequently spawn just outside
		// our local horizon.
		target = nearestPassiveFoodMob(bot, 64);
		if (target) return await tryHunt(bot, target, before);

		// Step 3: commit to a cardinal we haven't tried in this incident.
		const untried = CARDINALS.filter((c) => !triedCardinals.has(c.name));
		if (untried.length === 0) {
			return {
				ok: false,
				code: "exhausted",
				detail: "tried all 4 cardinals without finding a food mob — switch to village.relocate",
				worldDelta: null,
			};
		}
		const cardinal = untried[0];
		state.tried.add(cardinal.name);
		info("action", `scout-food: commit cardinal ${cardinal.name} for ${DEFAULT_COMMIT_DISTANCE}b`);
	const result = await patrolCardinal(bot, cardinal, DEFAULT_COMMIT_DISTANCE, ctx);
	if (result.aborted) return { ok: false, code: "preempted", worldDelta: null };
	if (result.target) return await tryHunt(bot, result.target, before);
	if (result.blocked) {
		return {
			ok: false,
			code: "blocked_heading",
			detail: { tried: cardinal.name, travelled: Math.round(result.travelled), drifted: result.drifted ?? null, error: result.error ?? null },
			worldDelta: { moved: Math.round(result.travelled), heading: cardinal.name, drifted: result.drifted ?? null, from_biome: biome },
		};
	}
	return {
		ok: false,
		code: "no_target",
		detail: { tried: cardinal.name, travelled: Math.round(result.travelled), error: result.error ?? null },
			worldDelta: { moved: Math.round(result.travelled), heading: cardinal.name, from_biome: biome },
		};
	},
	recover(ctx, result) {
		if (result.code === "exhausted") {
			return { hint: "relocate", reason: "scout-food exhausted all 4 cardinals; needs a long jump" };
		}
		if (result.code === "blocked_heading") {
			return { hint: "scout-food", reason: "chosen scout heading is blocked; retry another cardinal" };
		}
		if (result.code === "approached_target" || result.code === "no_path") {
			return { hint: "scout-food", reason: "made or attempted progress toward food target; rescan from current position" };
		}
		if (result.code === "no_target") {
			return { hint: "wander", reason: "scout completed leg without finding mob; try another cardinal" };
		}
		return null;
	},
});

async function tryHunt(bot, target, before) {
	ensurePathfinder(bot);
	setMovementsForTravel(bot);
	const start = bot.entity.position.clone?.() ?? { ...bot.entity.position };
	try {
		await Promise.race([
			bot.pathfinder.goto(new goals.GoalFollow(target.entity, 2)),
			new Promise((_, rej) => setTimeout(() => rej(new Error("path-to-mob timeout")), 30_000)),
		]);
	} catch (e) {
		try { bot.pathfinder?.stop?.(); } catch {}
		const moved = horizontalDistance(start, bot.entity.position);
		if (moved >= 6) {
			return {
				ok: false,
				code: "approached_target",
				detail: { target: target.entity.name, moved: Math.round(moved), mode: "pathfinder_partial", error: e?.message ?? "path failed" },
				worldDelta: { moved: Math.round(moved), target: target.entity.name, mode: "pathfinder_partial" },
			};
		}
		const yaw = yawToward(bot.entity.position, target.entity.position);
		if (yaw !== null) {
			const blind = await blindWalkOrTunnelOut(bot, {
				yaw,
				dirName: `toward-${target.entity.name}`,
				blindMs: 8_000,
				minMove: 4,
				reason: `scout-food target ${target.entity.name}`,
			});
			const afterBlind = horizontalDistance(start, bot.entity.position);
			if (blind.ok || afterBlind >= 4) {
				return {
					ok: false,
					code: "approached_target",
					detail: { target: target.entity.name, moved: Math.round(afterBlind), mode: "blind_target", error: e?.message ?? "path failed" },
					worldDelta: { moved: Math.round(afterBlind), target: target.entity.name, mode: "blind_target" },
				};
			}
		}
		return { ok: false, code: "no_path", detail: e?.message ?? "path failed", worldDelta: null };
	}
	info("action", `scout-food: engaging ${target.entity.name}@${target.distance.toFixed(1)}b`);
	for (let i = 0; i < 8; i++) {
		const current = Object.values(bot.entities ?? {}).find((e) => e.id === target.entity.id);
		if (!current) break;
		if (current.position.distanceTo(bot.entity.position) > 4) {
			try {
				await Promise.race([
					bot.pathfinder.goto(new goals.GoalFollow(current, 2)),
					new Promise((_, rej) => setTimeout(() => rej(new Error("repath timeout")), 8_000)),
				]);
			} catch {}
		}
		bot.attack(current);
		await new Promise((r) => setTimeout(r, 700));
	}
	await new Promise((r) => setTimeout(r, 1_000));
	const after = foodCount(bot);
	if (after <= before) {
		return { ok: false, code: "no_drop", detail: `hunted ${target.entity.name} but no edible drop`, worldDelta: null };
	}
	return {
		ok: true,
		code: "done",
		detail: { source: "hunt", mob: target.entity.name, gained: after - before },
		worldDelta: { acquiredFood: after - before, source: "hunt", mob: target.entity.name },
	};
}

function horizontalDistance(a, b) {
	return Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.z ?? 0) - (a?.z ?? 0));
}

function yawToward(from, to) {
	if (!from || !to) return null;
	const dx = to.x - from.x;
	const dz = to.z - from.z;
	if (Math.hypot(dx, dz) < 0.5) return null;
	return -Math.atan2(dx, dz);
}

// Test exports
export const __testing = {
	CARDINALS, PATROL_TICK_DISTANCE, DEFAULT_COMMIT_DISTANCE, PATROL_STEP_TIMEOUT_MS,
	nearestPassiveFoodMob, currentBiomeName, scanForFoodCapableNeighbourBiome,
	cardinalProgress, dominantCardinal, horizontalDistance, yawToward,
};
