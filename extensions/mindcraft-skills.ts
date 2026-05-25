// Mindcraft-backed Pi tools for pepa-pi-bot.
//
// Wraps battle-tested skill primitives from Mindcraft (MIT) — see
// extensions/lib/world.js, extensions/lib/skills.js, extensions/lib/mcdata.js,
// and extensions/lib/LICENSE-MINDCRAFT.
//
// This extension complements mineflayer-bridge.ts (auth, memory, chat,
// escalation, trust). It does NOT replace it; both extensions run side-by-side,
// registering disjoint Pi tools. Old broken mc_goto / mc_build_pyramid_5x5
// in bridge.ts are deprecated in favour of the perception+action set below.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Lazy access to the Mineflayer bot instance held by mineflayer-bridge.ts.
function getBot(): any {
	const bot = (globalThis as any).__pepaPiBot;
	if (!bot) throw new Error("Mineflayer bot is not connected (or bridge has not exposed __pepaPiBot yet).");
	return bot;
}

// ---- parameter schemas ----------------------------------------------------

const EMPTY_PARAMS = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const SCAN_PARAMS = {
	type: "object",
	properties: {
		radius: { type: "number", description: "Block radius (default 16, max 48)." },
	},
	additionalProperties: false,
} as const;

const BLOCK_NAME_COUNT_PARAMS = {
	type: "object",
	properties: {
		blockType: { type: "string", description: "Minecraft block name, e.g. 'oak_log', 'cobblestone'." },
		count: { type: "number", description: "How many to collect. Default 1." },
	},
	required: ["blockType"],
	additionalProperties: false,
} as const;

const PLACE_PARAMS = {
	type: "object",
	properties: {
		blockType: { type: "string", description: "Block name in inventory to place." },
		x: { type: "number" },
		y: { type: "number" },
		z: { type: "number" },
	},
	required: ["blockType", "x", "y", "z"],
	additionalProperties: false,
} as const;

const GOTO_PARAMS = {
	type: "object",
	properties: {
		x: { type: "number" },
		y: { type: "number" },
		z: { type: "number" },
		minDistance: { type: "number", description: "Stop when within this distance (default 2)." },
	},
	required: ["x", "y", "z"],
	additionalProperties: false,
} as const;

const GOTO_BLOCK_PARAMS = {
	type: "object",
	properties: {
		blockType: { type: "string" },
		minDistance: { type: "number" },
		range: { type: "number", description: "Search radius. Default 64." },
	},
	required: ["blockType"],
	additionalProperties: false,
} as const;

const CONSUME_PARAMS = {
	type: "object",
	properties: {
		itemName: { type: "string", description: "Food name. Empty = any food in inventory." },
	},
	additionalProperties: false,
} as const;

const CRAFT_PARAMS = {
	type: "object",
	properties: {
		itemName: { type: "string" },
		num: { type: "number" },
	},
	required: ["itemName"],
	additionalProperties: false,
} as const;

const EQUIP_PARAMS = {
	type: "object",
	properties: {
		itemName: { type: "string" },
	},
	required: ["itemName"],
	additionalProperties: false,
} as const;

const DEFEND_PARAMS = {
	type: "object",
	properties: {
		range: { type: "number", description: "Reaction range. Default 9." },
	},
	additionalProperties: false,
} as const;

const AVOID_PARAMS = {
	type: "object",
	properties: {
		distance: { type: "number", description: "Move this many blocks away. Default 16." },
	},
	additionalProperties: false,
} as const;

const STAY_PARAMS = {
	type: "object",
	properties: {
		seconds: { type: "number" },
	},
	additionalProperties: false,
} as const;

// ---- helpers --------------------------------------------------------------

function clampRadius(r: number | undefined): number {
	const v = typeof r === "number" && isFinite(r) ? r : 16;
	return Math.max(1, Math.min(48, Math.floor(v)));
}

function textResult(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text", text }], details };
}

// Hard timeout wrapper. Mineflayer's collectBlock / pathfinder can hang
// indefinitely when the target block name doesn't match or the path is
// unreachable. Without this the entire Pi loop blocks until manual kill.
function withTimeout<T>(p: Promise<T> | T, ms: number, label: string): Promise<T> {
	return Promise.race([
		Promise.resolve(p),
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s — likely wrong block name, unreachable, or pathfinder stuck`)), ms),
		),
	]);
}

// ---- tool registration ----------------------------------------------------

export default async function mindcraftSkills(pi: ExtensionAPI) {
	// Load vendored ESM Mindcraft libs at extension init. Pi awaits the default
	// export, so registerTool calls below see fully-loaded modules.
	const [skillsMod, worldMod] = await Promise.all([
		import("./lib/skills.js" as any),
		import("./lib/world.js" as any),
	]);
	const skills = skillsMod as Record<string, (...args: any[]) => any>;
	const world = worldMod as Record<string, (...args: any[]) => any>;

	// safeCall: wraps a skill call with error labeling AND a hard timeout.
	// Without a timeout the Mindcraft skills (defendSelf / avoidEnemies / stay
	// / craftRecipe / etc.) can hang forever inside pathfinder / pvp loops if
	// the goal is unreachable, blocking the entire Pi loop. Observed live:
	// mc_avoid_enemies pending >10 min with no progress. Default 30s; callers
	// override per-tool (goToPosition gets 120s, etc).
	const safeCall = async <T>(
		label: string,
		fn: () => T | Promise<T>,
		timeoutMs: number = 30_000,
	): Promise<T> => {
		try {
			return await withTimeout(Promise.resolve().then(fn), timeoutMs, label);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`${label}: ${msg}`);
		}
	};

	// 1. mc_observe — one-shot perception snapshot.
	pi.registerTool({
		name: "mc_observe",
		label: "Observe Surroundings",
		description: "Return a compact JSON summary of nearby blocks, entities, inventory, position, health, food, weather, time of day. Always call before deciding a non-trivial action in autonomous mode.",
		promptSnippet: "Get a single JSON snapshot of everything around the bot.",
		parameters: SCAN_PARAMS,
		async execute(_id, params: { radius?: number }) {
			const bot = getBot();
			const radius = clampRadius(params?.radius);
			const blockTypes = world.getNearbyBlockTypes(bot, radius);
			const entities = world.getNearbyEntities(bot, radius);
			const players = world.getNearbyPlayerNames ? world.getNearbyPlayerNames(bot) : [];
			const inv = world.getInventoryCounts(bot);
			const pos = world.getPosition(bot);
			const biome = (() => {
				try { return world.getBiomeName(bot); } catch { return "unknown"; }
			})();
			const summary = {
				position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
				biome,
				time: bot.time?.timeOfDay ?? null,
				isDay: bot.time?.isDay ?? null,
				weather: { rain: !!bot.isRaining, thunder: !!bot.thunderState },
				health: bot.health,
				food: bot.food,
				saturation: bot.foodSaturation,
				inventory: inv,
				nearbyBlocks: blockTypes,
				nearbyEntityTypes: Array.from(new Set(entities.map((e: any) => e?.name ?? e?.type).filter(Boolean))),
				nearbyPlayers: players,
				entityCount: entities.length,
			};
			return textResult(JSON.stringify(summary, null, 2), summary);
		},
	});

	// 2. mc_inventory
	pi.registerTool({
		name: "mc_inventory",
		label: "Inventory",
		description: "List items in the bot's inventory as {name: count}.",
		parameters: EMPTY_PARAMS,
		async execute() {
			const bot = getBot();
			const inv = world.getInventoryCounts(bot);
			return textResult(JSON.stringify(inv), { inventory: inv });
		},
	});

	// 3. mc_nearby_blocks
	pi.registerTool({
		name: "mc_nearby_blocks",
		label: "Nearby Block Types",
		description: "List distinct nearby block types within radius (default 16). Useful for 'is there water/lava/log close?'.",
		parameters: SCAN_PARAMS,
		async execute(_id, params: { radius?: number }) {
			const bot = getBot();
			const types = world.getNearbyBlockTypes(bot, clampRadius(params?.radius));
			return textResult(JSON.stringify(types), { blockTypes: types });
		},
	});

	// 4. mc_nearby_entities
	pi.registerTool({
		name: "mc_nearby_entities",
		label: "Nearby Entities",
		description: "List entities (players, mobs, items, etc.) within radius (default 16). Returns name/type and approximate distance.",
		parameters: SCAN_PARAMS,
		async execute(_id, params: { radius?: number }) {
			const bot = getBot();
			const radius = clampRadius(params?.radius);
			const entities = world.getNearbyEntities(bot, radius);
			const me = bot.entity?.position;
			const out = entities.map((e: any) => ({
				type: e.name ?? e.type ?? "unknown",
				distance: me && e.position ? Math.round(me.distanceTo(e.position)) : null,
				username: e.username ?? null,
				position: e.position ? { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) } : null,
			}));
			return textResult(JSON.stringify(out), { entities: out });
		},
	});

	// 5. mc_collect_block
	pi.registerTool({
		name: "mc_collect_block",
		label: "Collect Block",
		description: "Move to and break N blocks of a given type, picking them up. Handles path, tool equip, and dig. Throws if the block can't be found in range.",
		parameters: BLOCK_NAME_COUNT_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { blockType: string; count?: number }) {
			const bot = getBot();
			const count = Math.max(1, Math.min(64, Math.floor(params.count ?? 1)));
			// Bulk collection in dense terrain reliably times out on the
			// upstream mineflayer-collectblock plugin (observed live: count=1
			// works in ~25s, count=8 hangs past 270s with the same blocks
			// in range). Loop single-block collects instead — each iteration
			// re-pathfinds from the bot's current position, which is robust
			// to the block-cache and pathfinder drift problems that cause
			// the hangs. Per-iter timeout 75s.
			let collected = 0;
			let consecutiveFails = 0;
			const errors: string[] = [];
			for (let i = 0; i < count; i++) {
				try {
					const ok = await withTimeout(
						skills.collectBlock(bot, params.blockType, 1),
						75_000,
						`collectBlock(${params.blockType}) iter ${i + 1}/${count}`,
					);
					if (ok) {
						collected++;
						consecutiveFails = 0;
					} else {
						consecutiveFails++;
						errors.push(`iter ${i + 1}: returned false`);
					}
				} catch (e: any) {
					consecutiveFails++;
					errors.push(`iter ${i + 1}: ${e?.message ?? String(e)}`);
				}
				if (consecutiveFails >= 3) {
					return textResult(
						`Collected ${collected}/${count} ${params.blockType}; aborted after 3 consecutive failures. Last errors: ${errors.slice(-3).join("; ")}`,
						{ collected, requested: count, errors: errors.slice(-3) },
					);
				}
			}
			return textResult(
				`Collected ${collected}/${count} ${params.blockType}${errors.length ? ` (${errors.length} iters failed but recovered)` : ""}.`,
				{ collected, requested: count, errors },
			);
		},
	});

	// 6. mc_place_block
	pi.registerTool({
		name: "mc_place_block",
		label: "Place Block",
		description: "Place one block from inventory at the given coordinates. Throws if you do not have the block or the target is not placeable.",
		parameters: PLACE_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { blockType: string; x: number; y: number; z: number }) {
			const bot = getBot();
			const ok = await safeCall(
				"placeBlock",
				() => skills.placeBlock(bot, params.blockType, params.x, params.y, params.z),
				30_000,
			);
			return textResult(ok ? `Placed ${params.blockType} at ${params.x},${params.y},${params.z}.` : `placeBlock returned false.`, { ok, ...params });
		},
	});

	// 7. mc_go_to
	pi.registerTool({
		name: "mc_go_to",
		label: "Go To Coords",
		description: "Walk/swim/path to the given coordinates. Will dig through soft obstacles (leaves) and jump as needed. Stop when within minDistance (default 2). Throws on noPath.",
		parameters: GOTO_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { x: number; y: number; z: number; minDistance?: number }) {
			const bot = getBot();
			const ok = await safeCall(
				`goToPosition(${params.x},${params.y},${params.z})`,
				() => skills.goToPosition(bot, params.x, params.y, params.z, params.minDistance ?? 2),
				120_000,
			);
			return textResult(ok ? `Arrived near ${params.x},${params.y},${params.z}.` : `goToPosition returned false.`, { ok, ...params });
		},
	});

	// 8. mc_go_to_block
	pi.registerTool({
		name: "mc_go_to_block",
		label: "Go To Nearest Block",
		description: "Find the nearest block of a given type within `range` (default 64) and walk to it.",
		parameters: GOTO_BLOCK_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { blockType: string; minDistance?: number; range?: number }) {
			const bot = getBot();
			const ok = await safeCall(
				`goToNearestBlock(${params.blockType})`,
				() => skills.goToNearestBlock(bot, params.blockType, params.minDistance ?? 2, params.range ?? 64),
				90_000,
			);
			return textResult(ok ? `Arrived near nearest ${params.blockType}.` : `goToNearestBlock returned false for ${params.blockType}.`, { ok, ...params });
		},
	});

	// 9. mc_craft
	pi.registerTool({
		name: "mc_craft",
		label: "Craft",
		description: "Craft an item by name from inventory. Will use a nearby crafting table when required. Throws if recipe unknown or resources missing.",
		parameters: CRAFT_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { itemName: string; num?: number }) {
			const bot = getBot();
			const ok = await safeCall(
				"craftRecipe",
				() => skills.craftRecipe(bot, params.itemName, Math.max(1, Math.floor(params.num ?? 1))),
				30_000,
			);
			return textResult(ok ? `Crafted ${params.itemName}.` : `craftRecipe returned false.`, { ok, ...params });
		},
	});

	// 10. mc_equip
	pi.registerTool({
		name: "mc_equip",
		label: "Equip Item",
		description: "Equip an item by name (tool, armor, food).",
		parameters: EQUIP_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { itemName: string }) {
			const bot = getBot();
			const ok = await safeCall("equip", () => skills.equip(bot, params.itemName), 15_000);
			return textResult(ok ? `Equipped ${params.itemName}.` : `equip returned false for ${params.itemName}.`, { ok, ...params });
		},
	});

	// 11. mc_consume
	pi.registerTool({
		name: "mc_consume",
		label: "Consume Food",
		description: "Eat food from inventory. If itemName empty, picks first food item.",
		parameters: CONSUME_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { itemName?: string }) {
			const bot = getBot();
			const ok = await safeCall("consume", () => skills.consume(bot, params.itemName ?? ""), 30_000);
			return textResult(ok ? `Ate ${params.itemName ?? "food"}.` : `consume returned false.`, { ok, ...params });
		},
	});

	// 12. mc_defend_self
	pi.registerTool({
		name: "mc_defend_self",
		label: "Defend Self",
		description: "Attack hostile mobs within range until clear. Uses best available weapon. Range default 9.",
		parameters: DEFEND_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { range?: number }) {
			const bot = getBot();
			const ok = await safeCall("defendSelf", () => skills.defendSelf(bot, params.range ?? 9), 45_000);
			return textResult(ok ? `Defended against hostiles.` : `defendSelf returned false.`, { ok, ...params });
		},
	});

	// 13. mc_avoid_enemies
	pi.registerTool({
		name: "mc_avoid_enemies",
		label: "Avoid Enemies",
		description: "Move away from the nearest hostile entities by approx N blocks. Default 16.",
		parameters: AVOID_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { distance?: number }) {
			const bot = getBot();
			const ok = await safeCall("avoidEnemies", () => skills.avoidEnemies(bot, params.distance ?? 16), 45_000);
			return textResult(ok ? `Avoided enemies.` : `avoidEnemies returned false.`, { ok, ...params });
		},
	});

	// 14. mc_stay
	pi.registerTool({
		name: "mc_stay",
		label: "Stay In Place",
		description: "Stand still for N seconds (default 30). Useful for waiting out night, regen, or letting world state change.",
		parameters: STAY_PARAMS,
		executionMode: "sequential",
		async execute(_id, params: { seconds?: number }) {
			const bot = getBot();
			const secs = Math.max(1, Math.min(600, Math.floor(params.seconds ?? 30)));
			await safeCall("stay", () => skills.stay(bot, secs), secs * 1000 + 10_000);
			return textResult(`Stood still for ${secs}s.`, { seconds: secs });
		},
	});

	// 15. mc_pickup_nearby
	pi.registerTool({
		name: "mc_pickup_nearby",
		label: "Pickup Nearby Items",
		description: "Walk over and pick up any dropped item entities within ~8 blocks.",
		parameters: EMPTY_PARAMS,
		executionMode: "sequential",
		async execute() {
			const bot = getBot();
			const ok = await safeCall("pickupNearbyItems", () => skills.pickupNearbyItems(bot), 30_000);
			return textResult(ok ? `Picked up nearby items.` : `pickupNearbyItems returned false.`);
		},
	});
}
