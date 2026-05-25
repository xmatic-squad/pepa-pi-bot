// Mineflayer action primitives. Each function is async, has a hard timeout,
// catches its own errors, and returns { ok: boolean, detail?: any }.
// Actions are dispatched from the reflex layer via ctx.dispatch — never
// awaited inline in a tick, because they may take seconds.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;

import { info, warn } from "./log.js";

// Hard timeout wrapper. Mineflayer goals (pathfinder, pvp targeting) can hang
// when the goal is unreachable; without a ceiling the whole reflex chain stops.
function withTimeout(promise, ms, label) {
	return Promise.race([
		Promise.resolve(promise),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
		),
	]);
}

// Mineflayer ships with the pathfinder plugin externally — but we need to
// ensure it's loaded exactly once per bot. The reflex bot doesn't auto-load
// it the way mineflayer-bridge.ts did, so we lazy-load here.
let pluginLoaded = new WeakSet();
function ensurePathfinder(bot) {
	if (pluginLoaded.has(bot)) return;
	bot.loadPlugin(pathfinder);
	pluginLoaded.add(bot);
}

// ---- combat ----------------------------------------------------------------

const MELEE_WEAPONS = [
	"netherite_sword",
	"diamond_sword",
	"iron_sword",
	"stone_sword",
	"golden_sword",
	"wooden_sword",
	"netherite_axe",
	"diamond_axe",
	"iron_axe",
	"stone_axe",
	"golden_axe",
	"wooden_axe",
];

async function equipBestMelee(bot) {
	for (const name of MELEE_WEAPONS) {
		const item = bot.inventory.items().find((i) => i.name === name);
		if (item) {
			try {
				await bot.equip(item, "hand");
				return name;
			} catch {
				// keep trying
			}
		}
	}
	return null;
}

export async function attackNearest(bot, hostileType) {
	const target = Object.values(bot.entities).find(
		(e) => (hostileType ? e.name === hostileType : isHostile(e)) && e.position.distanceTo(bot.entity.position) <= 4,
	);
	if (!target) return { ok: false, detail: "no target in reach" };

	const weapon = await equipBestMelee(bot);
	info("action", `attack: target=${target.name} dist=${target.position.distanceTo(bot.entity.position).toFixed(1)} weapon=${weapon ?? "fists"}`);
	try {
		// Look at target then swing. Single hit per call — reflex tick re-fires
		// until the target is dead or out of range.
		await withTimeout(bot.lookAt(target.position.offset(0, target.height ?? 1, 0)), 2000, "lookAt");
		bot.attack(target);
		return { ok: true, detail: { target: target.name, weapon } };
	} catch (e) {
		warn("action", `attack failed: ${e.message}`);
		return { ok: false, detail: e.message };
	}
}

// ---- flee ------------------------------------------------------------------

export async function fleeFrom(bot, fromEntity, distance = 16) {
	ensurePathfinder(bot);
	const from = fromEntity?.position ?? bot.entity.position;
	const here = bot.entity.position;
	// vector away
	const dx = here.x - from.x;
	const dz = here.z - from.z;
	const len = Math.hypot(dx, dz) || 1;
	const tx = Math.round(here.x + (dx / len) * distance);
	const tz = Math.round(here.z + (dz / len) * distance);
	const ty = Math.round(here.y);
	info("action", `flee: from=${fromEntity?.name ?? "?"} → ${tx},${ty},${tz}`);

	const movements = new Movements(bot);
	movements.canDig = false;
	movements.allow1by1towers = false;
	bot.pathfinder.setMovements(movements);

	try {
		await withTimeout(
			bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 1)),
			30_000,
			`fleeFrom(${fromEntity?.name})`,
		);
		return { ok: true, detail: { to: { x: tx, y: ty, z: tz } } };
	} catch (e) {
		warn("action", `flee failed: ${e.message}`);
		return { ok: false, detail: e.message };
	}
}

// ---- food ------------------------------------------------------------------

const FOOD_PRIORITY = [
	"cooked_beef",
	"cooked_porkchop",
	"cooked_mutton",
	"cooked_chicken",
	"cooked_rabbit",
	"cooked_salmon",
	"cooked_cod",
	"baked_potato",
	"bread",
	"carrot",
	"apple",
	"sweet_berries",
	"melon_slice",
	"beef",
	"porkchop",
	"chicken",
	"mutton",
];

function findFood(bot) {
	for (const name of FOOD_PRIORITY) {
		const item = bot.inventory.items().find((i) => i.name === name);
		if (item) return item;
	}
	// fallback: anything with food value via mc-data is too brittle; we accept
	// only the priority list to avoid accidentally eating poisonous spider eyes.
	return null;
}

export async function eatBestFood(bot) {
	const item = findFood(bot);
	if (!item) return { ok: false, detail: "no food in inventory" };
	info("action", `eat: ${item.name}`);
	try {
		await withTimeout(bot.equip(item, "hand"), 3000, "equip food");
		await withTimeout(bot.consume(), 15_000, "consume");
		return { ok: true, detail: { ate: item.name } };
	} catch (e) {
		warn("action", `eat failed: ${e.message}`);
		return { ok: false, detail: e.message };
	}
}

// ---- sleep -----------------------------------------------------------------

const BED_NAMES = [
	"red_bed",
	"white_bed",
	"orange_bed",
	"yellow_bed",
	"lime_bed",
	"green_bed",
	"cyan_bed",
	"light_blue_bed",
	"blue_bed",
	"purple_bed",
	"magenta_bed",
	"pink_bed",
	"brown_bed",
	"gray_bed",
	"light_gray_bed",
	"black_bed",
];

export async function sleepInBed(bot) {
	// Already in a bed?
	if (bot.isSleeping) return { ok: true, detail: "already sleeping" };

	// Find a nearby placed bed first.
	const bedBlock = bot.findBlock({
		matching: (b) => BED_NAMES.includes(b?.name),
		maxDistance: 16,
	});

	if (bedBlock) {
		info("action", `sleep: nearest bed at ${bedBlock.position.x},${bedBlock.position.y},${bedBlock.position.z}`);
		ensurePathfinder(bot);
		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2)),
				15_000,
				"goto bed",
			);
			await withTimeout(bot.sleep(bedBlock), 10_000, "bot.sleep");
			return { ok: true, detail: { bedAt: bedBlock.position } };
		} catch (e) {
			warn("action", `sleep failed: ${e.message}`);
			return { ok: false, detail: e.message };
		}
	}

	// No placed bed — try placing one if we carry one. Skip — we don't want to
	// invent a base location accidentally. Future: only place when at our base
	// per locations.json.
	return { ok: false, detail: "no bed in range and won't place blindly" };
}

// ---- navigation (for operator come/follow) --------------------------------

export async function goTo(bot, x, y, z, minDistance = 2) {
	ensurePathfinder(bot);
	info("action", `goTo: ${x},${y},${z} (min ${minDistance})`);
	try {
		await withTimeout(
			bot.pathfinder.goto(new goals.GoalNear(x, y, z, minDistance)),
			60_000,
			`goTo(${x},${y},${z})`,
		);
		return { ok: true, detail: { x, y, z } };
	} catch (e) {
		warn("action", `goTo failed: ${e.message}`);
		return { ok: false, detail: e.message };
	}
}

// ---- helpers ---------------------------------------------------------------

const HOSTILE_NAMES = new Set([
	"zombie",
	"skeleton",
	"creeper",
	"spider",
	"witch",
	"pillager",
	"vindicator",
	"husk",
	"stray",
	"drowned",
	"phantom",
	"enderman",
	"slime",
	"magma_cube",
	"hoglin",
	"piglin_brute",
	"ravager",
	"warden",
	"breeze",
	"bogged",
]);

export function isHostile(entity) {
	return HOSTILE_NAMES.has((entity?.name || "").toLowerCase());
}
