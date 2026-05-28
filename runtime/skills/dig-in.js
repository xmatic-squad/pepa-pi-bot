// survive.dig-in — emergency night shelter when displaced with no bed/base
// (research QW8, §3 "If displaced at night"). The classic survival move: dig
// straight down a couple of blocks for cover, cap the hole with a placed
// block, and wait out the night. Mobs can't path into a sealed 1-wide hole.
//
// This is intentionally conservative and safety-gated: it refuses to dig into
// lava/water/void and never digs deeper than 3. The cap is best-effort —
// placement timing is finicky and we never want to FAIL the skill (and bounce
// the bot back to wandering at night) just because the roof block didn't seat;
// being two blocks underground is already far safer than standing in the open.

import { info, warn } from "../log.js";

const CAP_PREFERENCE = [
	"dirt", "cobblestone", "stone", "andesite", "diorite", "granite",
	"cobbled_deepslate", "deepslate", "sand", "gravel", "netherrack",
	"oak_planks", "spruce_planks", "birch_planks", "dark_oak_planks",
	"jungle_planks", "acacia_planks", "mangrove_planks", "cherry_planks",
];

const UNSAFE_BELOW = new Set([
	"lava", "flowing_lava", "water", "flowing_water", "bedrock",
	"air", "cave_air", "void_air",
]);

export function pickCapBlock(bot) {
	const items = bot.inventory?.items?.() ?? [];
	for (const name of CAP_PREFERENCE) {
		const found = items.find((i) => i.name === name && i.count > 0);
		if (found) return found;
	}
	return items.find((i) => /(_planks|_log|_wool|cobble|stone|dirt|sand|gravel|netherrack)$/i.test(i.name)) ?? null;
}

// Safe to dig the block directly below: it must be a solid, non-hazard block
// (don't open a hole into lava/water, don't waste a dig on air/bedrock).
export function safeToDigBelow(bot) {
	const pos = bot.entity?.position;
	if (!pos) return { ok: false, reason: "no position" };
	const below = bot.blockAt?.(pos.offset(0, -1, 0));
	if (!below) return { ok: false, reason: "no block below" };
	if (UNSAFE_BELOW.has(below.name)) return { ok: false, reason: `unsafe below: ${below.name}` };
	return { ok: true, block: below };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptCap(bot) {
	const pos = bot.entity?.position;
	if (!pos) return false;
	// Reference any solid block adjacent at the bot's head level; place onto
	// its top face to seal the column above the bot.
	const head = pos.offset(0, 1, 0);
	for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
		const ref = bot.blockAt?.(head.offset(dx, 0, dz));
		if (ref && !UNSAFE_BELOW.has(ref.name) && ref.name !== "air") {
			try {
				await bot.placeBlock(ref, { x: 0, y: 1, z: 0 });
				return true;
			} catch {
				// try next reference
			}
		}
	}
	return false;
}

export const skill = Object.freeze({
	id: "survive.dig-in",
	title: "Dig in for the night",
	timeoutMs: 30_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		if (!pickCapBlock(ctx.bot)) {
			return { ok: false, code: "missing_material", detail: "no placeable cap block (dirt/cobble/planks)" };
		}
		const safe = safeToDigBelow(ctx.bot);
		if (!safe.ok) return { ok: false, code: "unsafe_dig", detail: safe.reason };
		return { ok: true };
	},
	async execute(ctx, args = {}) {
		const bot = ctx.bot;
		try { bot.pathfinder?.setGoal?.(null); } catch {}

		const depth = Math.max(1, Math.min(args?.depth ?? 2, 3));
		let dug = 0;
		let lastReason = null;
		for (let i = 0; i < depth; i++) {
			const safe = safeToDigBelow(bot);
			if (!safe.ok) { lastReason = safe.reason; break; }
			try {
				await bot.dig(safe.block);
				dug++;
				await sleep(300); // let the bot drop into the new hole
			} catch (e) {
				lastReason = e?.message ?? String(e);
				break;
			}
		}

		if (dug === 0) {
			return { ok: false, code: "no_progress", detail: lastReason ?? "could not dig down", worldDelta: null };
		}

		let capped = false;
		const cap = pickCapBlock(bot);
		if (cap) {
			try { await bot.equip(cap, "hand"); } catch {}
			try { await bot.look(bot.entity.yaw, Math.PI / 2, true); } catch {}
			capped = await attemptCap(bot);
		}

		info("action", `dig-in: dug ${dug} down, capped=${capped}`);
		return {
			ok: true,
			code: "done",
			detail: { dug, capped, reason: lastReason },
			worldDelta: { dugDown: dug, capped, mode: "dig-in" },
		};
	},
	recover(ctx, result) {
		if (result.code === "missing_material") {
			return { hint: "wander", reason: "no cap block — gather dirt/cobble before nightfall" };
		}
		return null;
	},
});

export const __testing = { pickCapBlock, safeToDigBelow, attemptCap, CAP_PREFERENCE, UNSAFE_BELOW };
