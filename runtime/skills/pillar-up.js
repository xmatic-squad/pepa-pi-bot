// survive.pillar-up — escape a pit by placing blocks underneath the bot
// and jumping onto them. The classic Minecraft "pillaring" technique:
// look straight down, jump, place block at feet, repeat. Works with
// any solid placeable block (dirt, cobblestone, sand, etc.). Needs
// NO pickaxe — this is the bot's escape hatch when tunnel-out keeps
// failing because the surrounding terrain is unbreakable without tools.
//
// Strategy:
//   1. Find a placeable solid block in inventory (dirt > cobblestone >
//      stone > netherrack > anything solid).
//   2. Equip it.
//   3. Look straight down.
//   4. Loop up to MAX_PILLAR steps:
//      - Jump (control:on then off after delay).
//      - In the jump apex, place block on the block below the bot.
//      - Land on the new block.
//      - Check we actually rose +1 in Y.
//      - Stop early if we cleared open sky above (yaw test).

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder } = pathfinderPkg;
import { info, warn } from "../log.js";

const PILLAR_PREFERENCE = [
	"dirt", "cobblestone", "stone", "andesite", "diorite", "granite",
	"cobbled_deepslate", "deepslate", "sand", "gravel",
	"oak_planks", "spruce_planks", "birch_planks", "dark_oak_planks",
	"jungle_planks", "acacia_planks", "mangrove_planks", "cherry_planks",
	"netherrack",
];

let pathfinderLoaded = new WeakSet();
function ensurePathfinder(bot) {
	if (pathfinderLoaded.has(bot)) return;
	try { bot.loadPlugin(pathfinder); pathfinderLoaded.add(bot); } catch {}
}

function pickPillarBlock(bot) {
	const items = bot.inventory?.items?.() ?? [];
	for (const name of PILLAR_PREFERENCE) {
		const found = items.find((i) => i.name === name && i.count > 0);
		if (found) return found;
	}
	// Fallback: any block that looks placeable (has _block suffix or known names).
	const fallback = items.find((i) =>
		/^(.*_planks|.*_log|.*_wool|cobble|netherrack|stone|dirt|sand|gravel|terracotta|wood)$/i.test(i.name),
	);
	return fallback ?? null;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function placeBlockAtFeet(bot) {
	// Find the block directly below the bot (referenceBlock for placement).
	const pos = bot.entity?.position;
	if (!pos) return { ok: false, reason: "no position" };
	const below = bot.blockAt(pos.offset(0, -1, 0));
	if (!below) return { ok: false, reason: "no block below" };
	if (below.name === "air" || below.name === "cave_air" || below.name === "void_air") {
		// We're already mid-air — can't place on air. Need to land first.
		return { ok: false, reason: "below is air" };
	}
	try {
		// placeBlock direction: place on top face (vec3(0, 1, 0))
		await bot.placeBlock(below, { x: 0, y: 1, z: 0 });
		return { ok: true };
	} catch (e) {
		return { ok: false, reason: e?.message ?? String(e) };
	}
}

async function pillarStep(bot) {
	const startY = bot.entity?.position?.y ?? 0;

	// Look straight down so placement reference is correct.
	try { await bot.look(bot.entity.yaw, Math.PI / 2, true); } catch {}

	// Jump — engage control, hold briefly, release. Mineflayer's setControlState
	// handles the jump for us.
	bot.setControlState("jump", true);
	await sleep(80);
	bot.setControlState("jump", false);

	// In the apex (~200-300ms), try to place. Brief wait so we're airborne.
	await sleep(200);

	const place = await placeBlockAtFeet(bot);
	if (!place.ok) {
		// Likely either still on ground or in air — retry once with longer wait.
		await sleep(150);
		const retry = await placeBlockAtFeet(bot);
		if (!retry.ok) return { ok: false, reason: retry.reason };
	}

	// Wait for the bot to settle on the new block.
	await sleep(400);
	const endY = bot.entity?.position?.y ?? startY;
	const climbed = endY - startY;
	return { ok: climbed >= 0.5, climbed };
}

function inPit(bot) {
	// Heuristic "we're in a pit": there's a solid block within 3 blocks
	// in at least 2 of the 4 cardinal directions at head height.
	const pos = bot.entity?.position;
	if (!pos) return false;
	const head = pos.offset(0, 1, 0);
	let walls = 0;
	for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
		for (let r = 1; r <= 2; r++) {
			const b = bot.blockAt?.(head.offset(dx * r, 0, dz * r));
			if (b && b.name !== "air" && b.name !== "cave_air") {
				walls += 1;
				break;
			}
		}
	}
	return walls >= 2;
}

export const skill = Object.freeze({
	id: "survive.pillar-up",
	title: "Pillar up to escape a pit",
	timeoutMs: 45_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const block = pickPillarBlock(ctx.bot);
		if (!block) {
			return { ok: false, code: "missing_material", detail: "no placeable block in inventory (dirt/cobble/planks/etc.)" };
		}
		return { ok: true };
	},
	async execute(ctx, args = {}) {
		const bot = ctx.bot;
		ensurePathfinder(bot);
		// Stop any active pathing so we control movement.
		try { bot.pathfinder?.setGoal?.(null); } catch {}

		// Pick + equip a pillar block.
		const block = pickPillarBlock(bot);
		if (!block) {
			return { ok: false, code: "missing_material", detail: "no placeable block", worldDelta: null };
		}
		try {
			await bot.equip(block, "hand");
		} catch (e) {
			return { ok: false, code: "failed", detail: `equip failed: ${e?.message ?? e}`, worldDelta: null };
		}
		info("action", `pillar-up: using ${block.name} (x${block.count}) to climb`);

		const maxSteps = Math.max(2, Math.min(args?.maxSteps ?? 8, 16));
		const startY = bot.entity?.position?.y ?? 0;
		let placed = 0;
		let lastReason = null;

		for (let i = 0; i < maxSteps; i++) {
			const step = await pillarStep(bot);
			if (step.ok) {
				placed += 1;
				const inv = bot.inventory?.items?.().find((it) => it.type === block.type);
				if (!inv || inv.count <= 0) {
					info("action", `pillar-up: out of ${block.name} after ${placed} steps`);
					break;
				}
			} else {
				lastReason = step.reason;
				warn("action", `pillar-up: step ${i + 1} failed (${step.reason})`);
				// Retry a couple times before giving up — placement timing is finicky.
				if (i < 2) continue;
				break;
			}
		}

		try { bot.setControlState("jump", false); } catch {}
		const endY = bot.entity?.position?.y ?? startY;
		const climbed = endY - startY;
		const stillPit = inPit(bot);

		if (placed === 0) {
			return {
				ok: false,
				code: "no_progress",
				detail: lastReason ?? "could not place any blocks",
				worldDelta: null,
			};
		}
		if (stillPit && climbed < 2) {
			return {
				ok: false,
				code: "still_pitted",
				detail: { placed, climbed, lastReason },
				worldDelta: null,
			};
		}
		return {
			ok: true,
			code: "done",
			detail: { placed, climbed, blockType: block.name },
			worldDelta: { climbedY: climbed, mode: "pillar-up" },
		};
	},
	validate(ctx, result) {
		return result.ok && (result.worldDelta?.climbedY ?? 0) >= 1;
	},
	recover(ctx, result) {
		if (result.code === "missing_material") {
			return { hint: "wander", reason: "no pillar block; need to gather dirt or cobble" };
		}
		if (result.code === "still_pitted") {
			return { hint: "wander", reason: "pillar-up didn't escape; try tunnel-out next" };
		}
		return null;
	},
});

// Test exports
export const __testing = { pickPillarBlock, inPit, PILLAR_PREFERENCE };
