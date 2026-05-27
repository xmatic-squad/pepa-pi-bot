// Build a compact, JSON-safe snapshot of the world around the bot. Used both
// for reflex decisions and for periodic IPC STATUS events.

import { foods } from "./skills/groups.js";
import { findBlocksByName } from "./perception.js";

function vec3ToObj(v) {
	if (!v) return null;
	return { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(v.z * 100) / 100 };
}

const HOSTILE = new Set([
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

const PASSIVE = new Set([
	"cow",
	"pig",
	"chicken",
	"sheep",
	"rabbit",
	"mooshroom",
	"cod",
	"salmon",
]);

const INTERESTING_BLOCK_GROUPS = Object.freeze({
	logs: ["oak_log", "dark_oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "mangrove_log", "cherry_log", "pale_oak_log"],
	stone: ["stone", "cobblestone", "deepslate", "cobbled_deepslate", "andesite", "diorite", "granite"],
	water: ["water"],
	lava: ["lava", "fire", "soul_fire"],
	beds: ["white_bed", "orange_bed", "magenta_bed", "light_blue_bed", "yellow_bed", "lime_bed", "pink_bed", "gray_bed", "light_gray_bed", "cyan_bed", "purple_bed", "blue_bed", "brown_bed", "green_bed", "red_bed", "black_bed"],
	storage: ["chest", "trapped_chest", "barrel"],
	wool: ["white_wool", "orange_wool", "magenta_wool", "light_blue_wool", "yellow_wool", "lime_wool", "pink_wool", "gray_wool", "light_gray_wool", "cyan_wool", "purple_wool", "blue_wool", "brown_wool", "green_wool", "red_wool", "black_wool"],
	crops: ["wheat", "carrots", "potatoes", "beetroots", "sweet_berry_bush"],
	coal: ["coal_ore", "deepslate_coal_ore"],
});

function inventoryCounts(bot) {
	return (bot.inventory?.items?.() ?? []).reduce((acc, item) => {
		acc[item.name] = (acc[item.name] ?? 0) + item.count;
		return acc;
	}, {});
}

function countInterestingBlocks(bot, pos, radius = 16) {
	const out = {};
	for (const [kind, names] of Object.entries(INTERESTING_BLOCK_GROUPS)) {
		let positions = [];
		try {
			positions = findBlocksByName(bot, names, { maxDistance: radius, count: 16 });
		} catch {
			positions = [];
		}
		if (positions.length === 0) continue;
		const nearest = positions
			.map((p) => ({ position: vec3ToObj(p), distance: Math.round(Math.hypot(p.x - pos.x, p.z - pos.z) * 10) / 10 }))
			.sort((a, b) => a.distance - b.distance)[0];
		out[kind] = { count: positions.length, nearest };
	}
	return out;
}

function carriedEquipment(bot) {
	const slots = bot.inventory?.slots ?? [];
	return {
		hand: bot.heldItem?.name ?? null,
		head: slots[5]?.name ?? null,
		torso: slots[6]?.name ?? null,
		legs: slots[7]?.name ?? null,
		feet: slots[8]?.name ?? null,
	};
}

function hasEdibleFood(bot, inventory) {
	const allowed = foods(bot);
	return Object.keys(inventory ?? {}).some((name) => allowed.has(name));
}

function entityDistance(e, pos) {
	try {
		return Math.round(e.position.distanceTo(pos) * 10) / 10;
	} catch {
		return null;
	}
}

function entitySnapshot(e, pos) {
	return {
		name: e.username ?? e.name ?? e.displayName ?? "?",
		type: e.type ?? null,
		distance: entityDistance(e, pos),
		position: vec3ToObj(e.position),
	};
}

function blockNameAt(bot, pos) {
	try {
		return bot.blockAt(pos)?.name ?? null;
	} catch {
		return null;
	}
}

export function snapshot(bot) {
	if (!bot || !bot.entity) {
		return { connected: false };
	}
	const pos = bot.entity.position;
	const entities = Object.values(bot.entities || {});
	const players = entities.filter((e) => e.type === "player" && e.username && e.username !== bot.username);
	const hostiles = entities.filter((e) => HOSTILE.has((e.name || "").toLowerCase()));
	const closestHostile = hostiles.reduce((best, e) => {
		const d = e.position.distanceTo(pos);
		return !best || d < best.d ? { d, e } : best;
	}, null);

	const inventory = inventoryCounts(bot);
	const nearbyBlocks = countInterestingBlocks(bot, pos);
	const droppedItems = entities
		.filter((e) => e.type === "object" || e.name === "item")
		.filter((e) => e.position && e.position.distanceTo(pos) <= 24)
		.map((e) => entitySnapshot(e, pos))
		.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
		.slice(0, 12);
	const passives = entities
		.filter((e) => PASSIVE.has((e.name || "").toLowerCase()) && e.position)
		.map((e) => entitySnapshot(e, pos))
		.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
		.slice(0, 12);
	const footBlock = blockNameAt(bot, pos);
	const belowBlock = blockNameAt(bot, pos.offset(0, -1, 0));
	const headBlock = blockNameAt(bot, pos.offset(0, 1, 0));
	const hazards = {
		lavaNearby: !!nearbyBlocks.lava,
		inFluid: footBlock === "water" || footBlock === "lava",
		footBlock,
		belowBlock,
		headBlock,
	};

	return {
		connected: true,
		username: bot.username,
		position: vec3ToObj(pos),
		health: bot.health,
		food: bot.food,
		saturation: bot.foodSaturation,
		experience: bot.experience?.level,
		time: bot.time?.timeOfDay,
		isDay: bot.time?.isDay,
		weather: { rain: bot.isRaining, thunder: bot.thundering },
		dimension: bot.game?.dimension,
		inventory,
		hasFood: hasEdibleFood(bot, inventory),
		equipment: carriedEquipment(bot),
		nearbyBlocks,
		nearbyEntities: {
			passives,
			droppedItems,
		},
		hazards,
		biome: bot.blockAt?.(pos)?.biome?.name ?? bot.blockAt?.(pos)?.biome ?? null,
		players: players.map((p) => ({ name: p.username, distance: Math.round(p.position.distanceTo(pos)) })),
		hostileCount: hostiles.length,
		closestHostile: closestHostile
			? { name: closestHostile.e.name, distance: Math.round(closestHostile.d * 10) / 10 }
			: null,
	};
}
