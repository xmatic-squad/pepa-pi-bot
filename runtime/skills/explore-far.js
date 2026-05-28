// explore.far — walk ~48 blocks in a single direction, away from where
// the bot currently stands. Used as the wander hint target when
// gather.* skills can't find their resource in the bot's immediate
// neighbourhood (e.g. spawn protection with no trees inside 64 blocks).
//
// Picks a heading by quadrant rotation (NE → SE → SW → NW) so successive
// calls actually circle the spawn instead of bouncing within the same
// patch.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, Movements } = pathfinderPkg;

import { info, warn } from "../log.js";
import { digEscapeTunnel } from "./recovery-tunnel-out.js";

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
		const beforeProbe = clonePos(bot.entity.position);
		const trials = await probeCardinalStep(bot, 800);
		const movable = trials.filter((t) => t.dist > 0.5);

		// Journal-aware: if more than one direction is walkable, prefer the
		// one in the LEANEST quadrant (least amount of stuff we've already
		// catalogued, including dead_end markers — so we don't loop the same
		// area). Falls back to "best by distance" when only one direction
		// works or journal is empty.
		let best = trials.reduce((b, t) => (t.dist > b.dist ? t : b), { dist: 0, yaw: 0, name: "?" });
		if (movable.length > 1 && ctx?.journal?.leanestQuadrant) {
			const here = bot.entity.position;
			const { best: leanest } = ctx.journal.leanestQuadrant({ x: here.x, z: here.z, radius: 96 });
			const QUAD_TO_CARDINAL = { NE: "N", SE: "E", SW: "S", NW: "W" };
			const preferredName = QUAD_TO_CARDINAL[leanest];
			const preferred = movable.find((t) => t.name === preferredName);
			if (preferred) best = preferred;
			info("action", `explore.far: journal says leanest quadrant=${leanest} → prefer ${preferredName}`);
		}
		info("action", `explore.far: cardinal probe trials=${trials.map((t) => `${t.name}:${t.dist.toFixed(1)}`).join(" ")} best=${best.name}`);

		if (best.dist < 0.5) {
			// All cardinals blocked. Try the cheap vertical escape first; if it
			// does not actually move us, carve a short horizontal tunnel. The
			// previous code returned OK after dig-up+jump even when position was
			// unchanged, causing repeated false "done" completions.
			info("action", "explore.far: wedged — escape-pit, then tunnel-out if still stuck");
			const escape = await escapePit(bot, 3);
			const detail = { ...(escape.detail ?? {}), trials };
			if (!escape.ok) {
				return { ok: false, code: escape.code ?? "wedged", detail, worldDelta: escape.worldDelta ?? null };
			}
			return { ok: true, code: "done", detail, worldDelta: escape.worldDelta ?? null };
		}

		const here = bot.entity.position.clone();
		const tx = Math.round(here.x + Math.sin(-best.yaw) * dist);
		const tz = Math.round(here.z + Math.cos(-best.yaw) * dist);
		const ty = Math.round(here.y);
		info("action", `explore.far: blind-walking ${best.name} toward ${tx},${ty},${tz}`);
		return blindWalkOrTunnelOut(bot, {
			yaw: best.yaw,
			dirName: best.name,
			blindMs: args.blindMs ?? 20_000,
			minMove: args.minMove ?? Math.min(14, Math.max(8, dist * 0.25)),
			tunnelPushMs: args.tunnelPushMs,
			reason: `explore.far blind ${best.name}`,
			intended: { x: tx, y: ty, z: tz },
		});
	},
});

export async function blindWalkOrTunnelOut(bot, { yaw, dirName, blindMs = 7_000, minMove = 0.75, tunnelPushMs, reason = "blind fallback", intended = null } = {}) {
	const before = clonePos(bot.entity.position);
	try { await bot.look(yaw, 0, true); } catch {}
	bot.setControlState("forward", true);
	bot.setControlState("jump", true);
	try {
		await new Promise((r) => setTimeout(r, Math.max(0, blindMs)));
	} finally {
		bot.setControlState("forward", false);
		bot.setControlState("jump", false);
	}

	const moved = horizontalDistance(before, bot.entity.position);
	if (moved >= minMove) {
		return {
			ok: true,
			code: "done",
			detail: { mode: "blind-moved", previousMode: "blind", dir: dirName, moved, intended },
			worldDelta: { movedTo: clonePos(bot.entity.position) },
		};
	}

	info("action", `explore.far: blind ${dirName} moved only ${moved.toFixed(2)} horizontally → tunnel-out`);
	const tunnelArgs = { maxSteps: 3, reason };
	if (tunnelPushMs !== undefined) tunnelArgs.pushMs = tunnelPushMs;
	const tunnel = await digEscapeTunnel(bot, tunnelArgs);
	const detail = { mode: "blind", dir: dirName, moved, recovery: tunnel.detail ?? null };
	if (!tunnel.ok) {
		return {
			ok: false,
			code: tunnel.code ?? "wedged",
			detail,
			worldDelta: tunnel.worldDelta ?? null,
		};
	}
	return {
		ok: true,
		code: "done",
		detail: { ...(tunnel.detail ?? {}), previousMode: "blind", recovered: true },
		worldDelta: tunnel.worldDelta ?? { movedTo: clonePos(bot.entity.position) },
	};
}

export const _internal = { blindWalkOrTunnelOut };

const CARDINAL_YAWS = [
	{ name: "N", yaw: Math.PI },
	{ name: "E", yaw: -Math.PI / 2 },
	{ name: "S", yaw: 0 },
	{ name: "W", yaw: Math.PI / 2 },
];

function clonePos(pos) {
	if (typeof pos?.clone === "function") return pos.clone();
	return { x: pos?.x ?? 0, y: pos?.y ?? 0, z: pos?.z ?? 0 };
}

function horizontalDistance(a, b) {
	return Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.z ?? 0) - (a?.z ?? 0));
}

function verticalGain(a, b) {
	return (b?.y ?? 0) - (a?.y ?? 0);
}

async function escapePit(bot, maxSteps = 3) {
	const before = clonePos(bot.entity.position);
	for (let i = 0; i < maxSteps; i++) {
		const head = bot.entity.position.offset(0, 1.7, 0);
		const above = bot.blockAt(head.offset(0, 0.5, 0));
		if (!above || above.name === "air" || above.name === "cave_air" || above.name === "void_air") {
			bot.setControlState("jump", true);
			bot.setControlState("forward", true);
			await new Promise((r) => setTimeout(r, 700));
			bot.setControlState("jump", false);
			bot.setControlState("forward", false);
			continue;
		}
		try { await withTimeout(bot.lookAt(above.position.offset(0.5, 0.5, 0.5), true), 1_500, "lookAt-up"); } catch {}
		try {
			await withTimeout(bot.dig(above), 8_000, "dig-up");
		} catch (e) {
			warn("action", `escape-pit dig-up failed: ${e.message}`);
			break;
		}
		bot.setControlState("jump", true);
		await new Promise((r) => setTimeout(r, 600));
		bot.setControlState("jump", false);
		await new Promise((r) => setTimeout(r, 400));
	}

	// Let jump physics settle before deciding whether escape-pit worked.
	// Vertical-only motion is not freedom from a wedged shaft; require real
	// horizontal movement, otherwise fall through to the tunnel-out skill.
	await new Promise((r) => setTimeout(r, 500));
	const moved = horizontalDistance(before, bot.entity.position);
	const climbed = verticalGain(before, bot.entity.position);
	if (moved >= 0.75) {
		return {
			ok: true,
			code: "done",
			detail: { mode: "escape-pit-up", moved, climbed },
			worldDelta: { mode: "escape-pit-up", movedTo: clonePos(bot.entity.position) },
		};
	}
	info("action", `escape-pit moved only ${moved.toFixed(2)} horizontally (dy=${climbed.toFixed(2)}) → tunnel-out`);
	return digEscapeTunnel(bot, { maxSteps: 3, reason: "explore.far escape-pit" });
}

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
