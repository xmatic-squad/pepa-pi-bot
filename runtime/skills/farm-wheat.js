// farm.wheat — opportunistic wheat farming. The skill does ONE of:
//   * plant a wheat seed on a nearby tilled farmland block, OR
//   * till a grass/dirt block adjacent to water if we have a hoe and seeds,
//   * harvest a fully-grown wheat block.
//
// We don't try to plan a full 3×3 plot in one call — the curriculum can
// dispatch the skill repeatedly and each call makes one block of progress.
// This is consistent with the gather.logs / gather.stone "one block at a
// time" rhythm and keeps each tick observable.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;

import { applyProfile, PROFILES } from "../movement-profiles.js";
import { info, warn } from "../log.js";

const HOE_NAMES = ["wooden_hoe", "stone_hoe", "iron_hoe", "diamond_hoe", "netherite_hoe", "golden_hoe"];

let pluginLoaded = new WeakSet();
function ensurePathfinder(bot) {
	if (pluginLoaded.has(bot)) return;
	bot.loadPlugin(pathfinder);
	pluginLoaded.add(bot);
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getCount(bot, name) {
	return bot.inventory.items().reduce((s, i) => (i.name === name ? s + i.count : s), 0);
}

function getItem(bot, name) {
	return bot.inventory.items().find((i) => i.name === name) ?? null;
}

function hasHoe(bot) {
	return HOE_NAMES.some((n) => getCount(bot, n) > 0);
}

function findHoe(bot) {
	for (const n of HOE_NAMES) {
		const item = getItem(bot, n);
		if (item) return item;
	}
	return null;
}

function isWaterNear(bot, pos, radius = 4) {
	for (let dx = -radius; dx <= radius; dx++) {
		for (let dz = -radius; dz <= radius; dz++) {
			const b = bot.blockAt({ x: pos.x + dx, y: pos.y, z: pos.z + dz });
			if (b?.name === "water") return true;
		}
	}
	return false;
}

export const skill = Object.freeze({
	id: "farm.wheat",
	title: "Make one step of wheat farming progress",
	timeoutMs: 60_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const bot = ctx.bot;
		const hasSeeds = getCount(bot, "wheat_seeds") > 0;
		// We're happy to dispatch when EITHER seeds+hoe+water available
		// OR there's a ripe wheat block to harvest.
		const ripeWheat = bot.findBlock({
			matching: (b) => b?.name === "wheat" && (b?.metadata === 7 || b?.getProperties?.()?.age === 7),
			maxDistance: 24,
		});
		if (ripeWheat) return { ok: true };
		if (!hasSeeds) return { ok: false, code: "no_seeds", detail: "no wheat_seeds in inventory" };
		if (!hasHoe(bot)) return { ok: false, code: "missing_tool", detail: "no hoe" };
		// Need at least one tillable + water-adjacent block within 16.
		const tillable = bot.findBlock({
			matching: (b) => (b?.name === "grass_block" || b?.name === "dirt") && isWaterNear(bot, b.position, 4),
			maxDistance: 16,
		});
		if (!tillable) return { ok: false, code: "no_target", detail: "no tillable grass/dirt near water" };
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		ensurePathfinder(bot);
		applyProfile(PROFILES.GATHER, bot);

		// 1. Harvest ripe wheat if any.
		const ripeWheat = bot.findBlock({
			matching: (b) => b?.name === "wheat" && (b?.metadata === 7 || b?.getProperties?.()?.age === 7),
			maxDistance: 24,
		});
		if (ripeWheat) {
			try {
				await withTimeout(
					bot.pathfinder.goto(new goals.GoalGetToBlock(ripeWheat.position.x, ripeWheat.position.y, ripeWheat.position.z)),
					20_000,
					"goto wheat",
				);
				await withTimeout(bot.dig(ripeWheat), 8_000, "harvest wheat");
				info("action", `farm.wheat: harvested wheat at ${ripeWheat.position}`);
				return {
					ok: true,
					code: "done",
					detail: { phase: "harvest", at: ripeWheat.position },
					worldDelta: { harvestedAt: ripeWheat.position },
				};
			} catch (e) {
				warn("action", `farm.wheat harvest failed: ${e.message}`);
				return { ok: false, code: "failed", detail: e.message, worldDelta: null };
			}
		}

		// 2. Plant on existing farmland if any (water-adjacent or not, just farmland exists).
		const farmland = bot.findBlock({
			matching: (b) => b?.name === "farmland",
			maxDistance: 16,
		});
		const seedItem = getItem(bot, "wheat_seeds");
		if (farmland && seedItem) {
			try {
				await withTimeout(
					bot.pathfinder.goto(new goals.GoalNear(farmland.position.x, farmland.position.y, farmland.position.z, 1)),
					20_000,
					"goto farmland",
				);
				await withTimeout(bot.equip(seedItem, "hand"), 3000, "equip seeds");
				await withTimeout(
					bot.placeBlock(farmland, { x: 0, y: 1, z: 0 }),
					5000,
					"placeBlock(seeds)",
				);
				return {
					ok: true,
					code: "done",
					detail: { phase: "plant", at: farmland.position },
					worldDelta: { plantedAt: farmland.position },
				};
			} catch (e) {
				warn("action", `farm.wheat plant failed: ${e.message}`);
				// fall through to tilling
			}
		}

		// 3. Till a grass/dirt block next to water with our hoe.
		const tillable = bot.findBlock({
			matching: (b) => (b?.name === "grass_block" || b?.name === "dirt") && isWaterNear(bot, b.position, 4),
			maxDistance: 16,
		});
		if (!tillable) {
			return { ok: false, code: "no_target", detail: "no tillable block remaining", worldDelta: null };
		}
		const hoe = findHoe(bot);
		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalNear(tillable.position.x, tillable.position.y, tillable.position.z, 2)),
				20_000,
				"goto tillable",
			);
			await withTimeout(bot.equip(hoe, "hand"), 3000, "equip hoe");
			// Activate the block (right-click): turns grass/dirt → farmland.
			await withTimeout(bot.activateBlock(tillable), 5000, "till");
			return {
				ok: true,
				code: "done",
				detail: { phase: "till", at: tillable.position },
				worldDelta: { tilledAt: tillable.position },
			};
		} catch (e) {
			warn("action", `farm.wheat till failed: ${e.message}`);
			return { ok: false, code: "failed", detail: e.message, worldDelta: null };
		}
	},
});
