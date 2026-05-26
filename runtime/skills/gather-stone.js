// gather.stone — find a nearby stone/cobble/deepslate block, equip a
// pickaxe (best available), path to it and mine it. Stone-tier mining
// needs at least a wooden pickaxe — the preconditions enforce that.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;
import collectBlockPkg from "mineflayer-collectblock";
const collectBlockPlugin =
	collectBlockPkg.plugin ??
	collectBlockPkg.default?.plugin ??
	collectBlockPkg.default ??
	collectBlockPkg;
import toolPkg from "mineflayer-tool";
const toolPlugin = toolPkg.plugin ?? toolPkg.default?.plugin ?? toolPkg.default ?? toolPkg;

import { pickaxes } from "./groups.js";
import { info, warn } from "../log.js";
import { findNearestBlockByName } from "../perception.js";

const STONE_NAMES = ["stone", "cobblestone", "deepslate", "cobbled_deepslate", "andesite", "diorite", "granite"];

let pluginLoaded = new WeakSet();
function ensurePathfinder(bot) {
	if (pluginLoaded.has(bot)) return;
	bot.loadPlugin(pathfinder);
	pluginLoaded.add(bot);
}

let toolLoaded = new WeakSet();
function ensureTool(bot) {
	if (toolLoaded.has(bot)) return;
	bot.loadPlugin(toolPlugin);
	toolLoaded.add(bot);
}
let collectBlockLoaded = new WeakSet();
function ensureCollectBlock(bot) {
	ensurePathfinder(bot);
	ensureTool(bot);
	if (collectBlockLoaded.has(bot)) return;
	bot.loadPlugin(collectBlockPlugin);
	collectBlockLoaded.add(bot);
}

function setMovementsForGather(bot) {
	const m = new Movements(bot);
	m.canDig = true;
	m.allow1by1towers = false;
	bot.pathfinder.setMovements(m);
}

const PICKAXE_PRIORITY = ["netherite_pickaxe", "diamond_pickaxe", "iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"];
async function equipBestPickaxe(bot) {
	for (const name of PICKAXE_PRIORITY) {
		const item = bot.inventory.items().find((i) => i.name === name);
		if (item) {
			try {
				await bot.equip(item, "hand");
				return name;
			} catch {}
		}
	}
	return null;
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const stoneBlacklist = new WeakMap();
const BLACKLIST_TTL_MS = 5 * 60_000;

function getBlacklist(bot) {
	let m = stoneBlacklist.get(bot);
	if (!m) {
		m = new Map();
		stoneBlacklist.set(bot, m);
	}
	const now = Date.now();
	for (const [k, exp] of m) if (exp < now) m.delete(k);
	return m;
}

export const skill = Object.freeze({
	id: "gather.stone",
	title: "Gather cobblestone",
	timeoutMs: 90_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const available = pickaxes(ctx.bot);
		if (available.size === 0) {
			return { ok: false, code: "unsupported_version", detail: "no pickaxes in registry" };
		}
		const owned = ctx.bot.inventory.items().some((i) => available.has(i.name));
		if (!owned) {
			return { ok: false, code: "missing_tool", detail: "no pickaxe in inventory" };
		}
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		const blacklist = getBlacklist(bot);
		// Numeric-id search — callback matcher returns 0 under ViaBackwards. See runtime/perception.js.
		const target = findNearestBlockByName(bot, STONE_NAMES, {
			maxDistance: 32,
			predicate: (b) => !blacklist.has(`${b.position.x},${b.position.y},${b.position.z}`),
		});
		if (!target) {
			return { ok: false, code: "no_target", detail: "no reachable stone within 32 blocks", worldDelta: null };
		}

		ensureCollectBlock(bot);
		setMovementsForGather(bot);
		const pickaxe = await equipBestPickaxe(bot);
		info("action", `gather.stone: ${target.name} at ${target.position.x},${target.position.y},${target.position.z} (tool=${pickaxe ?? "fists"})`);
		const targetPos = target.position.clone();
		try {
			try {
				await withTimeout(bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), true), 2_000, "lookAt(stone)");
			} catch {}
			await withTimeout(bot.collectBlock.collect(target), 60_000, "collectStone");
			const after = bot.blockAt(targetPos);
			if (after && STONE_NAMES.includes(after.name)) {
				warn("action", `gather.stone reported ok but block still at ${targetPos.x},${targetPos.y},${targetPos.z} — silent dig failure`);
				const key = `${targetPos.x},${targetPos.y},${targetPos.z}`;
				blacklist.set(key, Date.now() + BLACKLIST_TTL_MS);
				return {
					ok: false,
					code: "silent_dig_failure",
					detail: "block still exists after collect — protocol/anti-cheat issue",
					worldDelta: null,
				};
			}
			return {
				ok: true,
				code: "done",
				detail: { blockType: target.name, at: targetPos },
				worldDelta: { minedAt: targetPos, blockType: target.name },
			};
		} catch (e) {
			warn("action", `gather.stone failed: ${e.message}`);
			const key = `${target.position.x},${target.position.y},${target.position.z}`;
			blacklist.set(key, Date.now() + BLACKLIST_TTL_MS);
			const msg = String(e?.message ?? "");
			const code = msg.includes("timed out") ? "timeout" : "failed";
			return { ok: false, code, detail: e.message, worldDelta: null };
		}
	},
	validate(ctx, result) {
		return result.ok && !!result.worldDelta?.blockType;
	},
	recover(ctx, result) {
		if (result.code === "no_target") return { hint: "wander", reason: "no stone within 32 blocks" };
		return null;
	},
});
