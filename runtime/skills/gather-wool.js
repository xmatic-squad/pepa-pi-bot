// gather.wool — get one block of wool, any colour. Three paths in order
// of preference:
//   1. Mine a placed wool block within 32 blocks (someone left one).
//   2. Shear a nearby sheep if we carry shears.
//   3. Attack a nearby sheep to drop wool (last resort; gives 1 wool).
//
// Wool is the only ingredient missing for a bed once we have planks, so
// this skill is the first real "go find an animal" task the bot has.

import collectBlockPkg from "mineflayer-collectblock";
import pathfinderPkg from "mineflayer-pathfinder";

import { info, warn } from "../log.js";

const { pathfinder, goals, Movements } = pathfinderPkg;
const collectBlockPlugin =
	collectBlockPkg.plugin ??
	collectBlockPkg.default?.plugin ??
	collectBlockPkg.default ??
	collectBlockPkg;

const WOOL_BLOCK_RE = /(?:^|_)wool$/;

let pluginLoaded = new WeakSet();
function ensurePlugins(bot) {
	if (pluginLoaded.has(bot)) return;
	bot.loadPlugin(pathfinder);
	bot.loadPlugin(collectBlockPlugin);
	pluginLoaded.add(bot);
}

function setMovementsForGather(bot) {
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

function woolCount(bot) {
	return bot.inventory.items().reduce(
		(sum, i) => (WOOL_BLOCK_RE.test(i.name) || i.name.endsWith("_wool") ? sum + i.count : sum),
		0,
	);
}

function nearestSheep(bot) {
	let best = null;
	for (const e of Object.values(bot.entities)) {
		if (e?.name !== "sheep" || !e.position) continue;
		const d = e.position.distanceTo(bot.entity.position);
		if (!best || d < best.d) best = { e, d };
	}
	return best;
}

export const skill = Object.freeze({
	id: "gather.wool",
	title: "Gather one wool",
	timeoutMs: 90_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		if (woolCount(ctx.bot) >= 3) {
			return { ok: false, code: "already_have", detail: "already have ≥3 wool" };
		}
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		ensurePlugins(bot);
		setMovementsForGather(bot);

		// 1. Placed wool block?
		const woolBlock = bot.findBlock({
			matching: (b) => b?.name && (b.name.endsWith("_wool") || b.name === "wool"),
			maxDistance: 32,
		});
		if (woolBlock) {
			info("action", `gather.wool: mining ${woolBlock.name} at ${woolBlock.position}`);
			try {
				await withTimeout(bot.collectBlock.collect(woolBlock), 45_000, "collectWool");
				return {
					ok: true,
					code: "done",
					detail: { from: "block", name: woolBlock.name },
					worldDelta: { gotWool: 1, source: "block" },
				};
			} catch (e) {
				warn("action", `gather.wool block-mine failed: ${e.message}`);
				// fall through to sheep
			}
		}

		// 2/3. Sheep — shear if we have shears, otherwise attack.
		const sheep = nearestSheep(bot);
		if (!sheep) {
			return { ok: false, code: "no_target", detail: "no wool block and no sheep within view", worldDelta: null };
		}
		try {
			await withTimeout(
				bot.pathfinder.goto(new goals.GoalFollow(sheep.e, 2)),
				30_000,
				"pathToSheep",
			);
		} catch (e) {
			return { ok: false, code: "no_path", detail: e.message, worldDelta: null };
		}

		const shears = bot.inventory.items().find((i) => i.name === "shears");
		if (shears) {
			try {
				await withTimeout(bot.equip(shears, "hand"), 3000, "equip shears");
				bot.activateEntity(sheep.e); // shears interaction
				await new Promise((r) => setTimeout(r, 600));
				// Wait for the drop entity to spawn near the sheep, then pick it up
				// by walking to it. Simplest: a brief wait — the bot is already next
				// to the sheep, drops are auto-collected.
				await new Promise((r) => setTimeout(r, 1200));
				return {
					ok: true,
					code: "done",
					detail: { from: "shear", entityId: sheep.e.id },
					worldDelta: { gotWool: 1, source: "shear" },
				};
			} catch (e) {
				warn("action", `gather.wool shear failed: ${e.message}`);
				// fall through to attack
			}
		}

		try {
			bot.attack(sheep.e);
			await new Promise((r) => setTimeout(r, 800));
			// Mineflayer doesn't auto-loop attacks; re-fire until dead or out
			// of reach. Up to 6 swings.
			for (let i = 0; i < 6; i++) {
				const still = Object.values(bot.entities).find((e) => e.id === sheep.e.id);
				if (!still) break;
				if (still.position.distanceTo(bot.entity.position) > 4) break;
				bot.attack(still);
				await new Promise((r) => setTimeout(r, 700));
			}
			await new Promise((r) => setTimeout(r, 1200));
			return {
				ok: true,
				code: "done",
				detail: { from: "kill", entityId: sheep.e.id },
				worldDelta: { gotWool: 1, source: "kill" },
			};
		} catch (e) {
			warn("action", `gather.wool attack failed: ${e.message}`);
			return { ok: false, code: "failed", detail: e.message, worldDelta: null };
		}
	},
	recover(ctx, result) {
		if (result.code === "no_target") return { hint: "wander", reason: "no sheep or wool block visible" };
		return null;
	},
});
