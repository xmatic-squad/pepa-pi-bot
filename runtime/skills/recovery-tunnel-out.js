// recovery.tunnel-out — last-resort wedged recovery. When cardinal probes
// report no movement and the old "dig up + jump" escape does not change
// position, carve a short two-high tunnel in the safest/most-open cardinal
// direction and push forward through it.

import { info, warn } from "../log.js";

const CARDINALS = Object.freeze([
	{ name: "N", yaw: Math.PI, dx: 0, dz: -1 },
	{ name: "E", yaw: -Math.PI / 2, dx: 1, dz: 0 },
	{ name: "S", yaw: 0, dx: 0, dz: 1 },
	{ name: "W", yaw: Math.PI / 2, dx: -1, dz: 0 },
]);

const PASSABLE_NAMES = new Set(["air", "cave_air", "void_air"]);
const LIQUID_NAMES = new Set(["water", "lava"]);

const NEVER_DIG_EXACT = new Set([
	"bedrock",
	"barrier",
	"command_block",
	"chain_command_block",
	"repeating_command_block",
	"structure_block",
	"jigsaw",
	"end_portal_frame",
	"end_portal",
	"nether_portal",
	"obsidian",
	"crying_obsidian",
	"respawn_anchor",
	"chest",
	"trapped_chest",
	"barrel",
	"shulker_box",
	"furnace",
	"blast_furnace",
	"smoker",
	"crafting_table",
	"stonecutter",
	"grindstone",
	"enchanting_table",
	"loom",
	"cartography_table",
	"fletching_table",
	"composter",
	"lectern",
	"bell",
	"cauldron",
]);

const MAN_MADE_PARTS = [
	"_planks",
	"_slab",
	"_stairs",
	"_fence",
	"_door",
	"_trapdoor",
	"glass",
	"pane",
	"brick",
	"concrete",
	"terracotta",
	"wool",
	"carpet",
	"banner",
	"sign",
	"torch",
	"lantern",
	"ladder",
	"rail",
	"anvil",
	"bookshelf",
	"lectern",
	"bell",
	"polished_",
	"chiseled_",
	"smooth_stone",
	"stripped_",
	"_bed",
];

const NATURAL_EXACT = new Set([
	"grass_block",
	"dirt",
	"coarse_dirt",
	"rooted_dirt",
	"podzol",
	"mycelium",
	"mud",
	"clay",
	"sand",
	"red_sand",
	"gravel",
	"snow",
	"snow_block",
	"powder_snow",
	"stone",
	"deepslate",
	"granite",
	"diorite",
	"andesite",
	"tuff",
	"calcite",
	"dripstone_block",
	"netherrack",
	"end_stone",
	"blackstone",
	"glowstone",
	"basalt",
	"moss_block",
	"mushroom_stem",
	"brown_mushroom_block",
	"red_mushroom_block",
]);

const TOOL_PRIORITY = Object.freeze({
	pickaxe: ["netherite_pickaxe", "diamond_pickaxe", "iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"],
	axe: ["netherite_axe", "diamond_axe", "iron_axe", "stone_axe", "wooden_axe"],
	shovel: ["netherite_shovel", "diamond_shovel", "iron_shovel", "stone_shovel", "wooden_shovel"],
});

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function posOffset(pos, dx, dy, dz) {
	if (typeof pos?.offset === "function") return pos.offset(dx, dy, dz);
	return { x: (pos?.x ?? 0) + dx, y: (pos?.y ?? 0) + dy, z: (pos?.z ?? 0) + dz };
}

function posClone(pos) {
	if (typeof pos?.clone === "function") return pos.clone();
	return { x: pos?.x ?? 0, y: pos?.y ?? 0, z: pos?.z ?? 0 };
}

function centerOf(pos) {
	if (typeof pos?.offset === "function") return pos.offset(0.5, 0.5, 0.5);
	return { x: (pos?.x ?? 0) + 0.5, y: (pos?.y ?? 0) + 0.5, z: (pos?.z ?? 0) + 0.5 };
}

function horizontalDistance(a, b) {
	return Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.z ?? 0) - (a?.z ?? 0));
}

function verticalDelta(a, b) {
	return (b?.y ?? 0) - (a?.y ?? 0);
}

function isLiquidBlock(block) {
	return LIQUID_NAMES.has(block?.name);
}

export function isPassableBlock(block) {
	if (!block) return true;
	if (PASSABLE_NAMES.has(block.name)) return true;
	return block.boundingBox === "empty";
}

function isProbablyNaturalName(name) {
	if (!name) return false;
	if (NATURAL_EXACT.has(name)) return true;
	return (
		name.endsWith("_leaves") ||
		name.endsWith("_log") ||
		name.endsWith("_stem") ||
		name.endsWith("_ore") ||
		name.endsWith("_dirt")
	);
}

function isUnsafeName(name) {
	if (!name) return true;
	if (PASSABLE_NAMES.has(name)) return false;
	if (LIQUID_NAMES.has(name)) return true;
	if (NEVER_DIG_EXACT.has(name)) return true;
	return MAN_MADE_PARTS.some((part) => name.includes(part));
}

export function isSafeTunnelDigTarget(bot, block) {
	if (isPassableBlock(block)) return true;
	if (!block?.position || isLiquidBlock(block)) return false;
	if (isUnsafeName(block.name)) return false;
	if (!isProbablyNaturalName(block.name)) return false;
	if (typeof bot?.canDigBlock === "function") {
		try {
			if (!bot.canDigBlock(block)) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function toolKindFor(name) {
	if (!name) return null;
	if (name.endsWith("_log") || name.endsWith("_stem") || name.endsWith("_leaves") || name.includes("mushroom")) return "axe";
	if (name.includes("dirt") || name.includes("sand") || name.includes("gravel") || name === "clay" || name.includes("snow") || name === "mud") return "shovel";
	if (name.includes("stone") || name.endsWith("_ore") || name === "granite" || name === "diorite" || name === "andesite" || name === "tuff" || name === "calcite") return "pickaxe";
	return null;
}

async function equipLikelyTool(bot, blockName) {
	const kind = toolKindFor(blockName);
	if (!kind) return null;
	const items = bot?.inventory?.items?.() ?? [];
	for (const toolName of TOOL_PRIORITY[kind]) {
		const item = items.find((i) => i.name === toolName);
		if (!item) continue;
		try {
			await withTimeout(bot.equip(item, "hand"), 3_000, `equip(${toolName})`);
			return toolName;
		} catch {
			// Try the next-best tool.
		}
	}
	return null;
}

function summarizeDirection(d) {
	return {
		name: d.name,
		usable: d.usable,
		score: Number.isFinite(d.score) ? d.score : null,
		digCount: d.digTargets.length,
		passable: d.passable,
		floor: d.floor,
		blockedBy: d.blockers.map((b) => `${b.kind}:${b.name}`),
		hazards: d.hazards.map((h) => `${h.kind}:${h.name}`),
	};
}

export function inspectTunnelDirection(bot, dir, maxSteps = 3) {
	const here = bot?.entity?.position;
	const digTargets = [];
	const blockers = [];
	const hazards = [];
	let passable = 0;
	let floor = 0;

	for (let step = 1; step <= maxSteps; step++) {
		const x = dir.dx * step;
		const z = dir.dz * step;
		for (const [kind, y] of [["head", 1], ["feet", 0]]) {
			const block = bot.blockAt(posOffset(here, x, y, z));
			if (isLiquidBlock(block)) {
				hazards.push({ step, kind, name: block.name });
			} else if (isPassableBlock(block)) {
				passable++;
			} else if (isSafeTunnelDigTarget(bot, block)) {
				digTargets.push({ step, kind, block });
			} else {
				blockers.push({ step, kind, name: block?.name ?? "unknown" });
			}
		}

		const below = bot.blockAt(posOffset(here, x, -1, z));
		if (isLiquidBlock(below)) hazards.push({ step, kind: "floor", name: below.name });
		else if (!isPassableBlock(below)) floor++;
	}

	const usable = blockers.length === 0 && hazards.length === 0;
	const score = usable ? passable * 3 + floor - digTargets.length * 2 : -Infinity;
	return { ...dir, usable, score, passable, floor, digTargets, blockers, hazards };
}

export function rankTunnelDirections(bot, maxSteps = 3) {
	return CARDINALS
		.map((dir) => inspectTunnelDirection(bot, dir, maxSteps))
		.sort((a, b) => (b.score - a.score) || (a.digTargets.length - b.digTargets.length));
}

async function digOne(bot, block) {
	if (isPassableBlock(block)) return false;
	const tool = await equipLikelyTool(bot, block.name);
	const timeoutMs = digTimeoutMs(block.name, tool);
	try {
		if (typeof bot.lookAt === "function") {
			await withTimeout(bot.lookAt(centerOf(block.position), true), 1_500, `lookAt(${block.name})`);
		}
	} catch {
		// Dig may still work; do not abort on look jitter.
	}
	await withTimeout(bot.dig(block), timeoutMs, `dig(${block.name})`);
	const after = bot.blockAt(block.position);
	if (after && !isPassableBlock(after) && after.name === block.name) {
		throw new Error(`block still present after dig: ${block.name}`);
	}
	return true;
}

function digTimeoutMs(blockName, equippedTool) {
	const kind = toolKindFor(blockName);
	if (!kind) return 12_000;
	if (equippedTool?.includes(kind)) return 12_000;
	if (kind === "pickaxe") return 25_000;
	if (kind === "axe") return 18_000;
	if (kind === "shovel") return 15_000;
	return 12_000;
}

async function pushForward(bot, yaw, ms) {
	try { await bot.look(yaw, 0, true); } catch {}
	bot.setControlState("forward", true);
	bot.setControlState("jump", true);
	try {
		await sleep(ms);
	} finally {
		bot.setControlState("forward", false);
		bot.setControlState("jump", false);
	}
}

export async function digEscapeTunnel(bot, { maxSteps = 3, minMove = 0.75, pushMs = 2_500, reason = "wedged" } = {}) {
	if (!bot?.entity?.position || typeof bot.blockAt !== "function" || typeof bot.dig !== "function") {
		return { ok: false, code: "no_bot", detail: "bot missing tunnel APIs", worldDelta: null };
	}

	const ranked = rankTunnelDirections(bot, maxSteps);
	const candidates = ranked.filter((d) => d.usable);
	if (!candidates.length) {
		return {
			ok: false,
			code: "no_safe_tunnel",
			detail: { mode: "tunnel-out", reason, directions: ranked.map(summarizeDirection) },
			worldDelta: { mode: "tunnel-out" },
		};
	}

	let lastError = null;
	for (const dir of candidates) {
		const before = posClone(bot.entity.position);
		info("action", `tunnel-out: ${reason} → ${dir.name} (${dir.digTargets.length} blocks to clear)`);
		try {
			let dug = 0;
			let lastStep = 0;
			const byStep = [...dir.digTargets]
				.sort((a, b) => (a.step - b.step) || (a.kind === "feet" ? -1 : 1));
			for (const target of byStep) {
				if (target.step !== lastStep && lastStep > 0) {
					await pushForward(bot, dir.yaw, Math.min(pushMs, 900));
				}
				lastStep = target.step;
				if (await digOne(bot, target.block)) dug++;
			}
			await pushForward(bot, dir.yaw, pushMs);
			const moved = horizontalDistance(before, bot.entity.position);
			const movedY = verticalDelta(before, bot.entity.position);
			if (moved >= minMove) {
				const movedTo = posClone(bot.entity.position);
				return {
					ok: true,
					code: "done",
					detail: { mode: "tunnel-out", dir: dir.name, moved, movedY, dug },
					worldDelta: { mode: "tunnel-out", movedTo },
				};
			}
			lastError = `dug ${dir.name} but moved only ${moved.toFixed(2)} horizontally (dy=${movedY.toFixed(2)})`;
			warn("action", `tunnel-out: ${lastError}`);
		} catch (e) {
			lastError = e?.message ?? String(e);
			warn("action", `tunnel-out ${dir.name} failed: ${lastError}`);
		}
	}

	return {
		ok: false,
		code: "wedged",
		detail: { mode: "tunnel-out", reason, error: lastError, directions: ranked.map(summarizeDirection) },
		worldDelta: { mode: "tunnel-out" },
	};
}

export const skill = Object.freeze({
	id: "recovery.tunnel-out",
	title: "Tunnel out of a wedged 1x1 hole",
	timeoutMs: 120_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		return { ok: true };
	},
	async execute(ctx, args = {}) {
		return digEscapeTunnel(ctx.bot, args);
	},
});

export const _internal = {
	CARDINALS,
	inspectTunnelDirection,
	rankTunnelDirections,
	isPassableBlock,
	isSafeTunnelDigTarget,
};
