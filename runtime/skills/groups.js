// Dynamic item/block groups derived from bot.registry. The goal is to never
// hard-code a Minecraft version's item table into skill code: skills ask for
// "logs" or "planks" or "beds", and this module returns the set of names that
// actually exist on the connected server.
//
// All helpers are pure: given a bot they return a Set<string>. They tolerate
// missing registries (returning an empty set) so the skill code can degrade
// to `code: "unsupported_version"` rather than crash.

function isItemRegistry(reg) {
	return reg && reg.itemsByName && typeof reg.itemsByName === "object";
}

function isBlockRegistry(reg) {
	return reg && reg.blocksByName && typeof reg.blocksByName === "object";
}

function pickItems(bot, predicate) {
	const reg = bot?.registry;
	if (!isItemRegistry(reg)) return new Set();
	const out = new Set();
	for (const name of Object.keys(reg.itemsByName)) {
		if (predicate(name)) out.add(name);
	}
	return out;
}

function pickBlocks(bot, predicate) {
	const reg = bot?.registry;
	if (!isBlockRegistry(reg)) return new Set();
	const out = new Set();
	for (const name of Object.keys(reg.blocksByName)) {
		if (predicate(name)) out.add(name);
	}
	return out;
}

// Wood + stem logs of every available species. The `*_stem` suffix covers
// crimson/warped logs; the `_log` suffix covers regular trees and pale_oak.
export function logs(bot) {
	return pickBlocks(bot, (n) => n.endsWith("_log") || n.endsWith("_stem"));
}

export function planks(bot) {
	return pickItems(bot, (n) => n.endsWith("_planks"));
}

export function sticks(bot) {
	const reg = bot?.registry;
	const out = new Set();
	if (isItemRegistry(reg) && reg.itemsByName.stick) out.add("stick");
	return out;
}

export function beds(bot) {
	return pickBlocks(bot, (n) => n.endsWith("_bed"));
}

// Conservative food allow-list. We could derive this from
// minecraft-data's foodsByName, but that includes spider_eye and other
// hazardous items. Until we have an explicit unsafe-food blacklist, keep
// the named cooked/raw/farm staples here and intersect with what exists in
// the connected server's item registry — so pale_oak-era new items don't
// surprise us and pre-1.13 servers don't blow up on missing entries.
const FOOD_ALLOWLIST = [
	"bread",
	"cooked_beef",
	"cooked_chicken",
	"cooked_porkchop",
	"cooked_mutton",
	"cooked_rabbit",
	"cooked_salmon",
	"cooked_cod",
	"baked_potato",
	"apple",
	"golden_apple",
	"carrot",
	"beetroot",
	"melon_slice",
	"sweet_berries",
	"glow_berries",
	"mushroom_stew",
	"rabbit_stew",
	"beetroot_soup",
	"suspicious_stew",
	"dried_kelp",
	"pumpkin_pie",
	"beef",
	"chicken",
	"porkchop",
	"mutton",
];

export function foods(bot) {
	const reg = bot?.registry;
	if (!isItemRegistry(reg)) return new Set();
	const out = new Set();
	for (const name of FOOD_ALLOWLIST) {
		if (reg.itemsByName[name]) out.add(name);
	}
	return out;
}

export function axes(bot) {
	const tools = ["wooden_axe", "stone_axe", "iron_axe", "golden_axe", "diamond_axe", "netherite_axe"];
	const reg = bot?.registry;
	if (!isItemRegistry(reg)) return new Set();
	return new Set(tools.filter((n) => reg.itemsByName[n]));
}

export function pickaxes(bot) {
	const tools = ["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "golden_pickaxe", "diamond_pickaxe", "netherite_pickaxe"];
	const reg = bot?.registry;
	if (!isItemRegistry(reg)) return new Set();
	return new Set(tools.filter((n) => reg.itemsByName[n]));
}

export function swords(bot) {
	const tools = ["wooden_sword", "stone_sword", "iron_sword", "golden_sword", "diamond_sword", "netherite_sword"];
	const reg = bot?.registry;
	if (!isItemRegistry(reg)) return new Set();
	return new Set(tools.filter((n) => reg.itemsByName[n]));
}
