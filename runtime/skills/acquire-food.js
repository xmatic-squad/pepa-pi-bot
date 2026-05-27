// survive.acquire-food — turn "hungry and no edible item" into a concrete
// world action. The first implementation is intentionally conservative:
// pick up nearby drops if they are already visible, otherwise hunt a nearby
// passive animal. It does not harvest player-looking crops.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;

import { info, warn } from "../log.js";
import { foods } from "./groups.js";

const PASSIVE_FOOD_MOBS = new Set(["cow", "pig", "chicken", "sheep", "rabbit", "mooshroom"]);

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

function foodCount(bot) {
	const allowed = foods(bot);
	return bot.inventory.items().reduce((sum, item) => allowed.has(item.name) ? sum + item.count : sum, 0);
}

function nearestPassiveFoodMob(bot, maxDistance = 32) {
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

function nearbyDroppedItems(bot, maxDistance = 8) {
	const here = bot?.entity?.position;
	if (!here) return [];
	return Object.values(bot.entities ?? {})
		.filter((e) => e?.position && (e.type === "object" || e.name === "item"))
		.map((e) => ({ entity: e, distance: e.position.distanceTo(here) }))
		.filter((e) => e.distance <= maxDistance)
		.sort((a, b) => a.distance - b.distance);
}

async function pickupNearbyDrops(bot) {
	ensurePathfinder(bot);
	setMovementsForTravel(bot);
	let picked = 0;
	for (const { entity } of nearbyDroppedItems(bot, 8).slice(0, 6)) {
		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 1)),
				8_000,
				"gotoDrop",
			);
			picked++;
		} catch {}
	}
	if (picked > 0) await new Promise((r) => setTimeout(r, 600));
	return picked;
}

export const skill = Object.freeze({
	id: "survive.acquire-food",
	title: "Acquire a basic food item",
	timeoutMs: 75_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		if (foodCount(ctx.bot) > 0) return { ok: false, code: "already_have", detail: "already carrying edible food" };
		if (nearestPassiveFoodMob(ctx.bot) || nearbyDroppedItems(ctx.bot, 8).length > 0) return { ok: true };
		return { ok: false, code: "no_target", detail: "no nearby food drops or passive food mobs" };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		const before = foodCount(bot);

		const picked = await pickupNearbyDrops(bot);
		if (foodCount(bot) > before) {
			return {
				ok: true,
				code: "done",
				detail: { source: "drop", picked },
				worldDelta: { acquiredFood: foodCount(bot) - before, source: "drop" },
			};
		}

		const target = nearestPassiveFoodMob(bot);
		if (!target) return { ok: false, code: "no_target", detail: "no passive food mob visible", worldDelta: null };

		ensurePathfinder(bot);
		setMovementsForTravel(bot);
		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalFollow(target.entity, 2)),
				30_000,
				"pathToFoodMob",
			);
		} catch (e) {
			return { ok: false, code: "no_path", detail: e.message, worldDelta: null };
		}

		info("action", `survive.acquire-food: hunting ${target.entity.name} (${target.distance.toFixed(1)}m)`);
		try {
			for (let i = 0; i < 8; i++) {
				const current = Object.values(bot.entities ?? {}).find((e) => e.id === target.entity.id);
				if (!current) break;
				if (current.position.distanceTo(bot.entity.position) > 4) {
					try {
						await withTimeout(
							bot.pathfinder.goto(new goals.GoalFollow(current, 2)),
							8_000,
							"repathFoodMob",
						);
					} catch {}
				}
				bot.attack(current);
				await new Promise((r) => setTimeout(r, 700));
			}
			await new Promise((r) => setTimeout(r, 1_000));
			await pickupNearbyDrops(bot);
			const after = foodCount(bot);
			if (after <= before) {
				return { ok: false, code: "no_drop", detail: `hunted ${target.entity.name} but found no edible drop`, worldDelta: null };
			}
			return {
				ok: true,
				code: "done",
				detail: { source: "hunt", mob: target.entity.name, gained: after - before },
				worldDelta: { acquiredFood: after - before, source: "hunt", mob: target.entity.name },
			};
		} catch (e) {
			warn("action", `survive.acquire-food failed: ${e.message}`);
			return { ok: false, code: "failed", detail: e.message, worldDelta: null };
		}
	},
	recover(ctx, result) {
		if (result.code === "no_target" || result.code === "no_path") {
			return { hint: "wander", reason: "need to search for passive food mobs" };
		}
		return null;
	},
});

export const _internal = { foodCount, nearestPassiveFoodMob };
