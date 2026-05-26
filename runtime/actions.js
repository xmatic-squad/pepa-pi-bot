// Mineflayer action primitives. Each function is async, has a hard timeout,
// catches its own errors, and returns { ok: boolean, detail?: any }.
// Actions are dispatched from the reflex layer via ctx.dispatch — never
// awaited inline in a tick, because they may take seconds.

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

import { info, warn } from "./log.js";
import { digEscapeTunnel } from "./skills/recovery-tunnel-out.js";
import { findNearestBlockByName } from "./perception.js";

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

// collectblock handles the full "find → approach → reposition → dig →
// pickup" cycle which raw bot.dig + pathfinder.goto does not. The old
// chop primitive "clicked once and stopped" because bot.dig requires a
// stable LoS that GoalGetToBlock doesn't always satisfy — bot ended up
// in leaves above the log and swung once with no progress.
let toolLoaded = new WeakSet();
function ensureTool(bot) {
	if (toolLoaded.has(bot)) return;
	bot.loadPlugin(toolPlugin);
	toolLoaded.add(bot);
}
let collectBlockLoaded = new WeakSet();
function ensureCollectBlock(bot) {
	ensurePathfinder(bot);
	ensureTool(bot); // collectblock requires bot.tool — see live error 2026-05-26
	if (collectBlockLoaded.has(bot)) return;
	bot.loadPlugin(collectBlockPlugin);
	collectBlockLoaded.add(bot);
}

// Each action that uses pathfinder should set its own Movements profile
// before calling goto — otherwise it inherits whatever the previous caller
// left set, which has caused live regressions (e.g. flee setting canDig=false,
// then a later chop inheriting the same restrictive profile).
function setMovementsForGather(bot) {
	const m = new Movements(bot);
	m.canDig = true; // chopping is the entire point
	m.allow1by1towers = false;
	bot.pathfinder.setMovements(m);
}

function setMovementsForTravel(bot) {
	const m = new Movements(bot);
	m.canDig = true; // dig through leaves rather than get stuck
	m.allow1by1towers = false;
	bot.pathfinder.setMovements(m);
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

	// canDig:true here is deliberate — without it the bot gets permanently
	// stuck in dense tree canopy (observed live: bot perched at Y=85 inside
	// dark-oak leaves, every flee timed out for hours). We accept the risk of
	// chopping through scenery while panicking; it's how a player would react.
	const movements = new Movements(bot);
	movements.canDig = true;
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

function carriedBedItem(bot) {
	for (const item of bot.inventory.items()) {
		if (BED_NAMES.includes(item.name)) return item;
	}
	return null;
}

export async function sleepInBed(bot) {
	// Already in a bed?
	if (bot.isSleeping) return { ok: true, detail: "already sleeping" };

	// 1. Find a nearby placed bed first. Numeric-id search — see chopNearestTree.
	const bedBlock = findNearestBlockByName(bot, BED_NAMES, { maxDistance: 16 });

	if (bedBlock) {
		info("action", `sleep: nearest bed at ${bedBlock.position.x},${bedBlock.position.y},${bedBlock.position.z}`);
		ensurePathfinder(bot);
		setMovementsForTravel(bot);
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

	// 2. No placed bed — if we're carrying one, place it right next to us
	// and sleep on it. This is critical so the bot stops blocking player
	// night-skipping the moment it owns a bed. We pick a footing block at
	// the bot's feet level + 1 in the +X direction.
	const carried = carriedBedItem(bot);
	if (carried) {
		const here = bot.entity.position;
		const referenceBlock = bot.blockAt(here.offset(1, -1, 0));
		const targetSlot = bot.blockAt(here.offset(1, 0, 0));
		if (!referenceBlock || !referenceBlock.boundingBox || referenceBlock.boundingBox === "empty") {
			return { ok: false, detail: "no solid ground to place bed on" };
		}
		if (targetSlot && targetSlot.boundingBox && targetSlot.boundingBox !== "empty") {
			return { ok: false, detail: "no space to place bed" };
		}
		try {
			await withTimeout(bot.equip(carried, "hand"), 3000, "equip bed");
			await withTimeout(
				bot.placeBlock(referenceBlock, { x: 0, y: 1, z: 0 }),
				5000,
				"placeBlock(bed)",
			);
			info("action", `sleep: placed ${carried.name} at ${referenceBlock.position.x + 0},${referenceBlock.position.y + 1},${referenceBlock.position.z + 0}`);
			// Re-scan for the placed bed (its block name may differ from the
			// item name slightly, e.g. on some servers, and the placement may
			// have shifted to an adjacent slot for the bed's second half).
			const placed = findNearestBlockByName(bot, BED_NAMES, { maxDistance: 4 });
			if (!placed) return { ok: false, detail: "placed bed not found after placement" };
			await withTimeout(bot.sleep(placed), 10_000, "bot.sleep(placed)");
			return { ok: true, detail: { bedAt: placed.position, placed: true, name: carried.name } };
		} catch (e) {
			warn("action", `sleep place+sleep failed: ${e.message}`);
			return { ok: false, detail: e.message };
		}
	}

	return { ok: false, detail: "no bed in inventory or nearby" };
}

// ---- gathering -------------------------------------------------------------

const LOG_NAMES = [
	"oak_log",
	"dark_oak_log",
	"spruce_log",
	"birch_log",
	"jungle_log",
	"acacia_log",
	"mangrove_log",
	"cherry_log",
	"pale_oak_log",
];

const AXE_NAMES = [
	"netherite_axe",
	"diamond_axe",
	"iron_axe",
	"stone_axe",
	"golden_axe",
	"wooden_axe",
];

async function equipBestAxe(bot) {
	for (const name of AXE_NAMES) {
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

// Per-bot blacklist of (x,y,z) positions that pathfinder failed to reach
// recently. Cleared after BLACKLIST_TTL_MS so the bot can retry if the world
// has changed (a player chopped a path, the tree fell to natural decay, etc).
const chopBlacklist = new WeakMap(); // bot → Map<"x,y,z", expireMs>
const BLACKLIST_TTL_MS = 5 * 60_000;

function getBlacklist(bot) {
	let m = chopBlacklist.get(bot);
	if (!m) {
		m = new Map();
		chopBlacklist.set(bot, m);
	}
	// Sweep expired entries on each lookup — small, cheap.
	const now = Date.now();
	for (const [k, exp] of m) if (exp < now) m.delete(k);
	return m;
}

export async function chopNearestTree(bot) {
	const blacklist = getBlacklist(bot);
	// Search radius widened to 64 (2026-05-26): live spawn at this server
	// had no trees in 32-block radius and the bot looped wander→gather→
	// fail forever. 64 ≈ one chunk in either direction.
	//
	// 2026-05-26 — bigger root-cause fix: stopped using bot.findBlock with
	// a callback matcher. Under ViaBackwards the Block objects fed into
	// the callback have wrong .name fields (mineflayer issue #2347), so
	// LOG_NAMES.includes(b.name) was always false and gather.logs reported
	// "no log within 64 blocks" while standing on dark_oak_leaves. We now
	// search by numeric registry id and post-filter the blacklist.
	const SEARCH_RADIUS = 64;
	const log = findNearestBlockByName(bot, LOG_NAMES, {
		maxDistance: SEARCH_RADIUS,
		predicate: (b) => !blacklist.has(`${b.position.x},${b.position.y},${b.position.z}`),
	});
	if (!log) return { ok: false, detail: `no reachable log within ${SEARCH_RADIUS} blocks` };

	// 2026-05-26: ground-truth verification + lookAt+force. On
	// play.xmatic.team (1.21 via ViaBackwards) bot.dig/collect can return
	// success even when the block survives — the server silently drops our
	// serverbound packet (project_mineflayer_via_protocol_pin). We refuse
	// to call it ok unless the block is actually gone from the world.
	ensureCollectBlock(bot);
	setMovementsForGather(bot);
	const axe = await equipBestAxe(bot);
	info(
		"action",
		`chop: ${log.name} at ${log.position.x},${log.position.y},${log.position.z} (tool=${axe ?? "fists"})`,
	);
	const targetPos = log.position.clone();
	const key = `${targetPos.x},${targetPos.y},${targetPos.z}`;
	try {
		try {
			await withTimeout(bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), true), 2_000, "lookAt(log)");
		} catch {}
		await withTimeout(bot.collectBlock.collect(log), 60_000, "collectLog");
		const after = bot.blockAt(targetPos);
		if (after && LOG_NAMES.includes(after.name)) {
			warn("action", `chop reported ok but log still at ${key} — silent dig failure`);
			blacklist.set(key, Date.now() + BLACKLIST_TTL_MS);
			return {
				ok: false,
				code: "silent_dig_failure",
				detail: "block still exists after collect — server dropped dig packet?",
				blacklisted: targetPos,
			};
		}
		return { ok: true, detail: { logType: log.name, at: targetPos } };
	} catch (e) {
		warn("action", `chop failed: ${e.message}`);
		// Promise.race timeouts do not cancel mineflayer-collectblock; an old
		// collect task can keep owning pathfinder and make every retry time out.
		try {
			await withTimeout(bot.collectBlock?.cancelTask?.() ?? Promise.resolve(), 2_000, "cancelCollectLog");
		} catch (cancelErr) {
			warn("action", `chop cancel failed: ${cancelErr.message}`);
			try { bot.pathfinder?.stop?.(); } catch {}
		}
		blacklist.set(key, Date.now() + BLACKLIST_TTL_MS);
		return { ok: false, detail: e.message, blacklisted: targetPos };
	}
}

// ---- exploration -----------------------------------------------------------

// wander — probe-then-go. Old version picked a random angle and trusted
// pathfinder; on this server pathfinder routinely times out (the bot is
// in a 3-block corridor, on a tree, in spawn area without good graph)
// and the blind-walk fallback then went in the SAME direction the
// pathfinder couldn't solve. 2026-05-26 fix: try every cardinal
// direction for 800 ms each, measure the actual Δ in-world, then commit
// to the best one for the rest of the budget.
export async function wander(bot, radius = 12) {
	ensurePathfinder(bot);
	setMovementsForTravel(bot);

	const trials = await probeCardinalSteps(bot, 800);
	const best = trials.reduce((b, t) => (t.dist > b.dist ? t : b), { dist: 0 });

	// If nothing moved at all, the bot is wedged — pit, corridor corner,
	// surrounded by leaves. Try to escape: dig the block straight above
	// + jump, repeat up to 3 times, then try forward+jump.
	if (best.dist < 0.5) {
		info("action", `wander: all cardinals blocked → escape-pit, then tunnel-out if still stuck`);
		const escape = await escapePit(bot, 3);
		const detail = { ...(escape.detail ?? {}), trials };
		if (!escape.ok) return { ok: false, code: escape.code ?? "wedged", detail };
		return { ok: true, detail };
	}

	// Commit to best direction.
	const wantDist = Math.max(6, Math.min(radius, best.dist * 4 + 2));
	const here = bot.entity.position;
	const tx = Math.round(here.x + Math.sin(-best.yaw) * wantDist);
	const tz = Math.round(here.z + Math.cos(-best.yaw) * wantDist);
	const ty = Math.round(here.y);
	info("action", `wander: best=${best.name}(Δ=${best.dist.toFixed(1)}) → ${tx},${ty},${tz}`);
	try {
		await withTimeout(
			bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 2)),
			12_000,
			`wander(${tx},${tz})`,
		);
		return { ok: true, detail: { to: { x: tx, y: ty, z: tz }, via: best.name } };
	} catch (e) {
		warn("action", `wander pathfinder failed: ${e.message} — continuing blind in ${best.name}`);
		const beforeBlind = clonePos(bot.entity.position);
		try { await bot.look(best.yaw, 0, true); } catch {}
		bot.setControlState("forward", true);
		bot.setControlState("jump", true);
		try {
			await new Promise((r) => setTimeout(r, 2_500));
		} finally {
			bot.setControlState("forward", false);
			bot.setControlState("jump", false);
		}
		const moved = horizontalDistance(beforeBlind, bot.entity.position);
		if (moved < 0.75) {
			info("action", `wander: blind ${best.name} moved only ${moved.toFixed(2)} horizontally → tunnel-out`);
			const tunnel = await digEscapeTunnel(bot, { maxSteps: 3, reason: `wander blind ${best.name}` });
			const detail = { to: { x: tx, y: ty, z: tz }, mode: "blind", via: best.name, moved, recovery: tunnel.detail ?? null };
			if (!tunnel.ok) return { ok: false, code: tunnel.code ?? "wedged", detail, worldDelta: tunnel.worldDelta ?? null };
			return { ok: true, detail: { ...(tunnel.detail ?? {}), previousMode: "blind", recovered: true }, worldDelta: tunnel.worldDelta ?? null };
		}
		return {
			ok: true,
			detail: { to: { x: tx, y: ty, z: tz }, mode: "blind-moved", previousMode: "blind", via: best.name, moved },
			worldDelta: { movedTo: clonePos(bot.entity.position) },
		};
	}
}

const CARDINAL_YAWS = [
	{ name: "N", yaw: Math.PI },
	{ name: "E", yaw: -Math.PI / 2 },
	{ name: "S", yaw: 0 },
	{ name: "W", yaw: Math.PI / 2 },
];

// escapePit — dig the block right above the bot's head, jump into the
// newly empty slot, repeat. If that does not actually move the bot, fall
// back to recovery.tunnel-out's two-high horizontal tunnel. Returning OK
// without movement was what produced repeated wedged "done" results.
function clonePos(pos) {
	if (typeof pos?.clone === "function") return pos.clone();
	return { x: pos?.x ?? 0, y: pos?.y ?? 0, z: pos?.z ?? 0 };
}

function horizontalDistance(a, b) {
	return Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.z ?? 0) - (a?.z ?? 0));
}

function verticalGain(a, b) {
	return (b?.y ?? 0) - (a?.y ?? 0);
}

async function escapePit(bot, maxSteps = 3) {
	const before = clonePos(bot.entity.position);
	for (let i = 0; i < maxSteps; i++) {
		const head = bot.entity.position.offset(0, 1.7, 0);
		const above = bot.blockAt(head.offset(0, 0.5, 0));
		if (!above || above.name === "air" || above.name === "cave_air" || above.name === "void_air") {
			// Already clear above. Just jump+forward in case bot is in a
			// horizontal pit (gap in floor).
			bot.setControlState("jump", true);
			bot.setControlState("forward", true);
			await new Promise((r) => setTimeout(r, 700));
			bot.setControlState("jump", false);
			bot.setControlState("forward", false);
			continue;
		}
		// Try to break the block above us. Force lookAt + 1-tick wait so the
		// server accepts the dig packet on protocol 775.
		try {
			await withTimeout(bot.lookAt(above.position.offset(0.5, 0.5, 0.5), true), 1_500, "lookAt-up");
		} catch {}
		try {
			await withTimeout(bot.dig(above), 8_000, "dig-up");
		} catch (e) {
			warn("action", `escape-pit dig-up failed: ${e.message}`);
			break;
		}
		// jump into the now-empty slot
		bot.setControlState("jump", true);
		await new Promise((r) => setTimeout(r, 600));
		bot.setControlState("jump", false);
		await new Promise((r) => setTimeout(r, 400));
	}

	// Let jump physics settle before deciding whether escape-pit worked.
	// Vertical-only motion is not freedom from a wedged shaft; require real
	// horizontal movement, otherwise fall through to the tunnel-out skill.
	await new Promise((r) => setTimeout(r, 500));
	const moved = horizontalDistance(before, bot.entity.position);
	const climbed = verticalGain(before, bot.entity.position);
	if (moved >= 0.75) {
		return { ok: true, code: "done", detail: { mode: "escape-pit-up", moved, climbed } };
	}
	info("action", `escape-pit moved only ${moved.toFixed(2)} horizontally (dy=${climbed.toFixed(2)}) → tunnel-out`);
	return digEscapeTunnel(bot, { maxSteps: 3, reason: "wander escape-pit" });
}

async function probeCardinalSteps(bot, durationMs = 800) {
	const trials = [];
	for (const { name, yaw } of CARDINAL_YAWS) {
		try { await bot.look(yaw, 0, true); } catch {}
		const before = bot.entity.position.clone();
		bot.setControlState("forward", true);
		try {
			await new Promise((r) => setTimeout(r, durationMs));
		} finally {
			bot.setControlState("forward", false);
		}
		const after = bot.entity.position;
		const dist = Math.hypot(after.x - before.x, after.z - before.z);
		trials.push({ name, yaw, dist });
		// settle physics
		await new Promise((r) => setTimeout(r, 150));
	}
	return trials;
}

// ---- crafting --------------------------------------------------------------
//
// Mineflayer's crafting API is two-step: find a recipe with bot.recipesFor()
// (which considers what's in inventory + nearby crafting tables), then call
// bot.craft(recipe, count, tableBlock?). For "needs a table" items the
// caller must place one within ~3 blocks first or pass the table block.
//
// We keep the actions small and explicit so the tech-tree reflex can compose
// them: chop → planks → sticks → table → axe → keep chopping (now faster).

function getItemCount(bot, name) {
	return bot.inventory.items().reduce((sum, i) => (i.name === name ? sum + i.count : sum), 0);
}

function getAnyPlanksCount(bot) {
	return bot.inventory
		.items()
		.reduce((sum, i) => (i.name.endsWith("_planks") ? sum + i.count : sum), 0);
}

function getAnyLogCount(bot) {
	return bot.inventory.items().reduce((sum, i) => (i.name.endsWith("_log") ? sum + i.count : sum), 0);
}

// Pick a recipe by item-name regardless of table presence.
function findRecipe(bot, itemName, tableBlock = null) {
	const mcdata = bot.registry ?? null;
	const itemId = mcdata?.itemsByName?.[itemName]?.id;
	if (itemId == null) return null;
	const recipes = bot.recipesFor(itemId, null, 1, tableBlock);
	return recipes[0] ?? null;
}

async function craftRecipe(bot, itemName, count = 1, tableBlock = null) {
	const recipe = findRecipe(bot, itemName, tableBlock);
	if (!recipe) {
		return { ok: false, detail: `no recipe for ${itemName} (have: ${summarizeInv(bot)})` };
	}
	try {
		await withTimeout(bot.craft(recipe, count, tableBlock), 15_000, `craft(${itemName})`);
		return { ok: true, detail: { item: itemName, count } };
	} catch (e) {
		return { ok: false, detail: `craft(${itemName}): ${e.message}` };
	}
}

function summarizeInv(bot) {
	const items = bot.inventory.items();
	if (!items.length) return "empty";
	return items
		.slice(0, 5)
		.map((i) => `${i.name}×${i.count}`)
		.join(",");
}

function isSolidPlacementSupport(block) {
	return !!block && block.boundingBox && block.boundingBox !== "empty" && !block.liquid;
}

function isClearPlacementTarget(block) {
	return !!block && block.boundingBox === "empty" && !block.liquid;
}

function findAdjacentTablePlacement(bot) {
	const here = bot.entity.position;
	const offsets = [
		[1, 0], [-1, 0], [0, 1], [0, -1],
		[1, 1], [1, -1], [-1, 1], [-1, -1],
	];
	for (const [dx, dz] of offsets) {
		const referenceBlock = bot.blockAt(here.offset(dx, -1, dz));
		const targetBlock = bot.blockAt(here.offset(dx, 0, dz));
		if (isSolidPlacementSupport(referenceBlock) && isClearPlacementTarget(targetBlock)) {
			return { referenceBlock, faceVector: { x: 0, y: 1, z: 0 }, target: targetBlock.position };
		}
	}
	return null;
}

// Convert any wood logs into planks (4 planks per log). Picks the first log
// type we have. Most recipes don't need a table.
export async function craftPlanks(bot, count = 4) {
	const log = bot.inventory.items().find((i) => i.name.endsWith("_log"));
	if (!log) return { ok: false, detail: "no log in inventory" };
	const planks = log.name.replace("_log", "_planks");
	info("action", `craft: ${count} ${planks} (from ${log.name})`);
	return craftRecipe(bot, planks, Math.ceil(count / 4));
}

// 2 planks → 4 sticks. No table needed.
export async function craftSticks(bot, count = 4) {
	if (getAnyPlanksCount(bot) < 2) return { ok: false, detail: "need 2 planks" };
	info("action", `craft: ${count} sticks`);
	return craftRecipe(bot, "stick", Math.ceil(count / 4));
}

// Place a crafting table at the bot's feet+1 (or near). Returns the placed
// block so subsequent craft calls can pass it as tableBlock.
export async function placeCraftingTable(bot) {
	// Already placed nearby? Numeric-id search — see chopNearestTree.
	const existing = findNearestBlockByName(bot, ["crafting_table"], { maxDistance: 4 });
	if (existing) return { ok: true, detail: { at: existing.position, reused: true }, block: existing };

	// Pick an adjacent placement target before crafting one. The old fallback
	// clicked the block directly beneath the bot, which attempts to place the
	// table in the bot's own feet block and can hang on Paper/ViaBackwards.
	const placement = findAdjacentTablePlacement(bot);
	if (!placement) return { ok: false, detail: "no clear adjacent block to place crafting table" };

	// Need to craft one first if we don't have it.
	if (getItemCount(bot, "crafting_table") === 0) {
		if (getAnyPlanksCount(bot) < 4) {
			return { ok: false, detail: "need 4 planks to craft a table" };
		}
		const craftRes = await craftRecipe(bot, "crafting_table", 1);
		if (!craftRes.ok) return craftRes;
	}

	const tableItem = bot.inventory.items().find((i) => i.name === "crafting_table");
	if (!tableItem) return { ok: false, detail: "crafting_table missing after craft" };
	try {
		await withTimeout(bot.equip(tableItem, "hand"), 3000, "equip table");
		try {
			await withTimeout(bot.lookAt(placement.referenceBlock.position.offset(0.5, 0.5, 0.5), true), 2000, "lookAt(table spot)");
		} catch {}
		await withTimeout(
			bot.placeBlock(placement.referenceBlock, placement.faceVector),
			5000,
			"placeBlock(table)",
		);
	} catch (e) {
		return { ok: false, detail: `place table: ${e.message}` };
	}
	const placedAtTarget = bot.blockAt(placement.target);
	const placed = placedAtTarget?.name === "crafting_table"
		? placedAtTarget
		: findNearestBlockByName(bot, ["crafting_table"], { maxDistance: 4 });
	if (!placed) return { ok: false, detail: "placed crafting table not found" };
	info("action", `craft: placed crafting_table at ${placed.position.x},${placed.position.y},${placed.position.z}`);
	return { ok: true, detail: { at: placed.position, reused: false }, block: placed };
}

export async function craftWoodenAxe(bot) {
	const tableRes = await placeCraftingTable(bot);
	if (!tableRes.ok) return tableRes;
	if (getAnyPlanksCount(bot) < 3) return { ok: false, detail: "need 3 planks" };
	if (getItemCount(bot, "stick") < 2) return { ok: false, detail: "need 2 sticks" };
	info("action", `craft: wooden_axe`);
	return craftRecipe(bot, "wooden_axe", 1, tableRes.block);
}

export async function craftWoodenPickaxe(bot) {
	const tableRes = await placeCraftingTable(bot);
	if (!tableRes.ok) return tableRes;
	if (getAnyPlanksCount(bot) < 3) return { ok: false, detail: "need 3 planks" };
	if (getItemCount(bot, "stick") < 2) return { ok: false, detail: "need 2 sticks" };
	info("action", `craft: wooden_pickaxe`);
	return craftRecipe(bot, "wooden_pickaxe", 1, tableRes.block);
}

export async function craftWoodenSword(bot) {
	const tableRes = await placeCraftingTable(bot);
	if (!tableRes.ok) return tableRes;
	if (getAnyPlanksCount(bot) < 2) return { ok: false, detail: "need 2 planks" };
	if (getItemCount(bot, "stick") < 1) return { ok: false, detail: "need 1 stick" };
	info("action", `craft: wooden_sword`);
	return craftRecipe(bot, "wooden_sword", 1, tableRes.block);
}

// Re-exported helpers for the reflex layer.
export const inv = { getItemCount, getAnyPlanksCount, getAnyLogCount };

// ---- navigation (for operator come/follow) --------------------------------

export async function goTo(bot, x, y, z, minDistance = 2) {
	ensurePathfinder(bot);
	setMovementsForTravel(bot);
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
