// gather.stone — find a nearby stone/cobble/deepslate block, equip a
// pickaxe (best available), path to it and mine it. Stone-tier mining
// needs at least a wooden pickaxe — the preconditions enforce that.

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;

import { pickaxes } from "./groups.js";
import { info, warn } from "../log.js";

const STONE_NAMES = ["stone", "cobblestone", "deepslate", "cobbled_deepslate", "andesite", "diorite", "granite"];

let pluginLoaded = new WeakSet();
function ensurePathfinder(bot) {
	if (pluginLoaded.has(bot)) return;
	bot.loadPlugin(pathfinder);
	pluginLoaded.add(bot);
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
		const target = bot.findBlock({
			matching: (b) => {
				if (!b || !b.position || !STONE_NAMES.includes(b.name)) return false;
				const key = `${b.position.x},${b.position.y},${b.position.z}`;
				return !blacklist.has(key);
			},
			maxDistance: 32,
		});
		if (!target) {
			return { ok: false, code: "no_target", detail: "no reachable stone within 32 blocks", worldDelta: null };
		}

		ensurePathfinder(bot);
		setMovementsForGather(bot);
		const pickaxe = await equipBestPickaxe(bot);
		info("action", `gather.stone: ${target.name} at ${target.position.x},${target.position.y},${target.position.z} (tool=${pickaxe ?? "fists"})`);
		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalGetToBlock(target.position.x, target.position.y, target.position.z)),
				45_000,
				"pathToStone",
			);
			await withTimeout(bot.dig(target), 30_000, "digStone");
			await new Promise((r) => setTimeout(r, 1200));
			return {
				ok: true,
				code: "done",
				detail: { blockType: target.name, at: target.position },
				worldDelta: { minedAt: target.position, blockType: target.name },
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
