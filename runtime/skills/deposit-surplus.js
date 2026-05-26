// village.deposit-surplus — find the nearest placed chest, open it, and
// transfer any stack the bot is over-carrying (logs, cobble, dirt,
// seeds). Keeps a small "essentials" reserve in inventory so the bot
// keeps its tools, food and bed.
//
// What counts as surplus:
//   * any item whose count exceeds RESERVE_PER_NAME (default: keep 8 of
//     each named item), UNLESS it's in KEEP_ALWAYS (tools/bed/food).
//   * raw materials that look strictly storable (logs/cobble/dirt/sand).

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals, Movements } = pathfinderPkg;

import { applyProfile, PROFILES } from "../movement-profiles.js";
import { info, warn } from "../log.js";

const KEEP_ALWAYS_NAME_RE = /(_axe|_pickaxe|_sword|_shovel|_hoe|_bed|bread|cooked_|apple|carrot|potato|wheat_seeds)$/;
const STORABLE_NAME_RE = /(_log$|_stem$|cobblestone|cobbled_deepslate|deepslate|stone$|dirt|sand|gravel|wheat$|_planks$|stick$)/;
const RESERVE_PER_NAME = 8;

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

function pickSurplus(bot) {
	const out = [];
	// Group inventory items by name, then decide how much to deposit per name.
	const grouped = new Map();
	for (const item of bot.inventory.items()) {
		if (!grouped.has(item.name)) grouped.set(item.name, []);
		grouped.get(item.name).push(item);
	}
	for (const [name, items] of grouped) {
		if (KEEP_ALWAYS_NAME_RE.test(name)) continue;
		const total = items.reduce((s, i) => s + i.count, 0);
		const storable = STORABLE_NAME_RE.test(name);
		const reserve = storable ? Math.min(RESERVE_PER_NAME, total) : 0;
		const surplus = total - reserve;
		if (surplus <= 0) continue;
		out.push({ name, surplus, items });
	}
	return out;
}

export const skill = Object.freeze({
	id: "village.deposit-surplus",
	title: "Deposit surplus items in a chest",
	timeoutMs: 60_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const surplus = pickSurplus(ctx.bot);
		if (surplus.length === 0) return { ok: false, code: "nothing_to_deposit", detail: "no surplus stacks" };
		const chest = ctx.bot.findBlock({
			matching: (b) => b?.name === "chest" || b?.name === "trapped_chest",
			maxDistance: 24,
		});
		if (!chest) return { ok: false, code: "no_chest", detail: "no chest within 24 blocks" };
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		const chest = bot.findBlock({
			matching: (b) => b?.name === "chest" || b?.name === "trapped_chest",
			maxDistance: 24,
		});
		if (!chest) return { ok: false, code: "no_chest", detail: "no chest after move", worldDelta: null };

		ensurePathfinder(bot);
		applyProfile(PROFILES.TRAVEL, bot);
		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 1)),
				30_000,
				"goto chest",
			);
		} catch (e) {
			return { ok: false, code: "no_path", detail: e.message, worldDelta: null };
		}

		let chestHandle;
		try {
			chestHandle = await withTimeout(bot.openContainer(chest), 8_000, "openChest");
		} catch (e) {
			return { ok: false, code: "open_failed", detail: e.message, worldDelta: null };
		}

		let deposited = 0;
		const detail = [];
		try {
			for (const { name, surplus } of pickSurplus(bot)) {
				const ref = bot.registry?.itemsByName?.[name];
				if (!ref) continue;
				try {
					await withTimeout(chestHandle.deposit(ref.id, null, surplus), 10_000, `deposit ${name}`);
					deposited += surplus;
					detail.push(`${name}×${surplus}`);
					info("action", `village.deposit-surplus: ${name}×${surplus}`);
				} catch (e) {
					warn("action", `village.deposit-surplus: ${name} failed: ${e.message}`);
				}
			}
		} finally {
			try { await chestHandle.close(); } catch {}
		}

		if (deposited === 0) {
			return { ok: false, code: "deposit_failed", detail: "opened chest but deposited nothing", worldDelta: null };
		}
		return {
			ok: true,
			code: "done",
			detail: { deposited, items: detail },
			worldDelta: { depositedTotal: deposited },
		};
	},
});
