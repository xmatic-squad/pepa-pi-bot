// Hierarchical needs ladder (Maslow-like). Each need has:
//   id          stable kebab-case
//   level       0-10, ascending priority (0 = most urgent)
//   title       Russian short label for chat narration
//   detect(s)   → bool, true means need is already satisfied
//   pursue(s)   → { skillId, args? } | null, what to do RIGHT NOW
//
// Need ordering matters: state.js picks the LOWEST-level unsatisfied
// need. If pursue() returns null we move on to the next level — that's
// how "I want armour but can't craft it yet" gracefully degrades to
// "go gather more iron".
//
// Snapshot shape comes from runtime/perceive.js#snapshot().

const PICKAXE_WOOD = ["wooden_pickaxe"];
const PICKAXE_STONE = ["stone_pickaxe"];
const PICKAXE_IRON = ["iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"];
const AXE_WOOD = ["wooden_axe"];
const AXE_STONE = ["stone_axe"];
const AXE_IRON = ["iron_axe", "diamond_axe", "netherite_axe"];
const SWORD_WOOD = ["wooden_sword"];
const SWORD_STONE = ["stone_sword"];
const SWORD_IRON = ["iron_sword", "diamond_sword", "netherite_sword"];
const FOOD_ITEMS = [
	"bread", "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton",
	"cooked_rabbit", "cooked_cod", "cooked_salmon", "baked_potato",
	"apple", "carrot", "potato", "beetroot", "melon_slice", "sweet_berries",
	"golden_apple", "golden_carrot",
];
const ARMOR_CHEST_ANY = [
	"leather_chestplate", "iron_chestplate", "golden_chestplate",
	"diamond_chestplate", "netherite_chestplate", "chainmail_chestplate",
];
const ARMOR_IRON_CHEST = ["iron_chestplate"];
const BED_ITEMS = [
	"white_bed", "orange_bed", "magenta_bed", "light_blue_bed", "yellow_bed",
	"lime_bed", "pink_bed", "gray_bed", "light_gray_bed", "cyan_bed",
	"purple_bed", "blue_bed", "brown_bed", "green_bed", "red_bed", "black_bed",
];

function hasAny(inv, names) {
	if (!inv) return false;
	for (const n of names) {
		if ((inv[n] ?? 0) > 0) return true;
	}
	return false;
}

function countAny(inv, names) {
	if (!inv) return 0;
	let total = 0;
	for (const n of names) total += inv[n] ?? 0;
	return total;
}

function countLogs(inv) {
	if (!inv) return 0;
	let total = 0;
	for (const [name, count] of Object.entries(inv)) {
		if (name.endsWith("_log")) total += count;
	}
	return total;
}

function countPlanks(inv) {
	if (!inv) return 0;
	let total = 0;
	for (const [name, count] of Object.entries(inv)) {
		if (name.endsWith("_planks")) total += count;
	}
	return total;
}

function hostileImminent(s) {
	const h = s?.closestHostile;
	if (!h) return false;
	return (h.distance ?? Infinity) < 8;
}

function aliveDetect(s) {
	if (!s?.connected) return true; // not connected, nothing to do
	const hp = s.health ?? 20;
	const food = s.food ?? 20;
	if (hp <= 5) return false;
	if (food <= 0) return false;
	if (s.hazards?.inFluid && s.hazards?.footBlock === "lava") return false;
	if (hostileImminent(s) && hp <= 10) return false;
	return true;
}

function alivePursue(s) {
	const hp = s.health ?? 20;
	const food = s.food ?? 20;
	if (s.hazards?.footBlock === "lava") {
		return { skillId: "recovery.tunnel-out", args: { reason: "lava" } };
	}
	if (food <= 0 && s.hasFood) {
		return { skillId: "survive.eat" };
	}
	if (food <= 0 && !s.hasFood) {
		return { skillId: "survive.acquire-food" };
	}
	if (hostileImminent(s)) {
		return { skillId: "survive.flee" };
	}
	if (hp <= 5) {
		return { skillId: "survive.flee" };
	}
	return null;
}

function foodDetect(s) {
	if (!s?.connected) return true;
	if ((s.food ?? 20) >= 18 && countAny(s.inventory, FOOD_ITEMS) >= 1) return true;
	return countAny(s.inventory, FOOD_ITEMS) >= 6;
}

function foodPursue(s) {
	if ((s.food ?? 20) < 16 && s.hasFood) {
		return { skillId: "survive.eat" };
	}
	return { skillId: "survive.acquire-food" };
}

function toolsWoodDetect(s) {
	const inv = s?.inventory;
	if (!inv) return false;
	return hasAny(inv, PICKAXE_WOOD) && hasAny(inv, AXE_WOOD) && hasAny(inv, SWORD_WOOD);
}

function toolsWoodPursue(s) {
	const inv = s.inventory ?? {};
	const planks = countPlanks(inv);
	const logs = countLogs(inv);
	const sticks = inv.stick ?? 0;
	const hasWb = (inv.crafting_table ?? 0) > 0
		|| (s.nearbyBlocks?.craftingTable ?? 0) > 0;

	if (logs < 2 && planks < 4 && !hasWb) {
		return { skillId: "gather.logs" };
	}
	if (planks < 4) {
		return { skillId: "craft.planks" };
	}
	if (sticks < 2) {
		return { skillId: "craft.sticks" };
	}
	if (!hasAny(inv, PICKAXE_WOOD)) {
		return { skillId: "craft.wooden-pickaxe" };
	}
	if (!hasAny(inv, AXE_WOOD)) {
		return { skillId: "craft.wooden-axe" };
	}
	if (!hasAny(inv, SWORD_WOOD)) {
		return { skillId: "craft.wooden-sword" };
	}
	return null;
}

function shelterBasicDetect(s) {
	const inv = s?.inventory ?? {};
	const bedPlaced = (s.nearbyBlocks?.beds ?? 0) > 0;
	return bedPlaced || hasAny(inv, BED_ITEMS);
}

function shelterBasicPursue(s) {
	const inv = s.inventory ?? {};
	if (!hasAny(inv, BED_ITEMS)) {
		const wool = countAny(inv, [
			"white_wool", "orange_wool", "magenta_wool", "light_blue_wool",
			"yellow_wool", "lime_wool", "pink_wool", "gray_wool",
			"light_gray_wool", "cyan_wool", "purple_wool", "blue_wool",
			"brown_wool", "green_wool", "red_wool", "black_wool",
		]);
		if (wool >= 3 && countPlanks(inv) >= 3) {
			return { skillId: "craft.bed" };
		}
		if (wool < 3) {
			return { skillId: "gather.wool" };
		}
		return { skillId: "gather.logs" };
	}
	// Have bed but no shelter — pick a base and build.
	const blocksForShelter = countPlanks(inv) + (inv.cobblestone ?? 0) + (inv.dirt ?? 0);
	if (blocksForShelter < 12) {
		return { skillId: "gather.stone" };
	}
	return { skillId: "village.build-shelter" };
}

function toolsStoneDetect(s) {
	const inv = s?.inventory;
	if (!inv) return false;
	return hasAny(inv, PICKAXE_STONE) && hasAny(inv, AXE_STONE) && hasAny(inv, SWORD_STONE);
}

function toolsStonePursue(s) {
	const inv = s.inventory ?? {};
	const cobble = inv.cobblestone ?? 0;
	const sticks = inv.stick ?? 0;
	if (cobble < 4) {
		return { skillId: "gather.stone" };
	}
	if (sticks < 2) {
		return { skillId: "craft.sticks" };
	}
	if (!hasAny(inv, PICKAXE_STONE)) {
		return { skillId: "craft.stone-pickaxe" };
	}
	if (!hasAny(inv, AXE_STONE)) {
		return { skillId: "craft.stone-axe" };
	}
	if (!hasAny(inv, SWORD_STONE)) {
		return { skillId: "craft.stone-sword" };
	}
	return null;
}

function armorBasicDetect(s) {
	const equip = s?.equipment ?? {};
	if (equip.torso && ARMOR_CHEST_ANY.includes(equip.torso)) return true;
	return hasAny(s.inventory, ARMOR_CHEST_ANY);
}

function armorBasicPursue(_s) {
	// No armor crafting skills registered yet (v0.3.x roadmap). Don't
	// stall the ladder — let later needs drive activity.
	return null;
}

function foodSecurityDetect(s) {
	return countAny(s?.inventory, FOOD_ITEMS) >= 16;
}

function foodSecurityPursue(s) {
	if ((s.inventory?.wheat_seeds ?? 0) > 0 && (s.nearbyBlocks?.crops ?? 0) > 0) {
		return { skillId: "farm.wheat" };
	}
	return { skillId: "survive.acquire-food" };
}

function toolsIronDetect(s) {
	const inv = s?.inventory;
	if (!inv) return false;
	return hasAny(inv, PICKAXE_IRON) && hasAny(inv, AXE_IRON) && hasAny(inv, SWORD_IRON);
}

function toolsIronPursue(_s) {
	// No iron-tool craft skills registered yet. Direct the bot to keep
	// mining — the registry will gain craft.iron-* in a later iteration.
	return { skillId: "gather.stone" };
}

function armorIronDetect(s) {
	const equip = s?.equipment ?? {};
	if (equip.torso === "iron_chestplate") return true;
	return hasAny(s.inventory, ARMOR_IRON_CHEST);
}

function armorIronPursue(_s) {
	return null;
}

function villageSeedDetect(s) {
	// Heuristic: at least one chest placed AND one bed placed within
	// nearby radius. Tightens later (POIs of kind "structure").
	const nb = s?.nearbyBlocks ?? {};
	return (nb.storage ?? 0) >= 1 && (nb.beds ?? 0) >= 1;
}

function villageSeedPursue(s) {
	const inv = s.inventory ?? {};
	if ((inv.chest ?? 0) === 0 && countPlanks(inv) >= 8) {
		return { skillId: "craft.chest" };
	}
	if ((inv.chest ?? 0) > 0) {
		return { skillId: "village.deposit-surplus" };
	}
	return { skillId: "village.build-shelter" };
}

function villageFullDetect(_s) {
	// Always false — it's the global goal.
	return false;
}

function villageFullPursue(_s) {
	// Let the curriculum tackle it (fallback chain).
	return null;
}

export const NEEDS = Object.freeze([
	{ id: "alive",           level: 0,  title: "Остаться живым",   detect: aliveDetect,         pursue: alivePursue },
	{ id: "food",            level: 1,  title: "Найти еду",         detect: foodDetect,          pursue: foodPursue },
	{ id: "tools_wood",      level: 2,  title: "Деревянные орудия", detect: toolsWoodDetect,     pursue: toolsWoodPursue },
	{ id: "shelter_basic",   level: 3,  title: "Простой шелтер",    detect: shelterBasicDetect,  pursue: shelterBasicPursue },
	{ id: "tools_stone",     level: 4,  title: "Каменные орудия",   detect: toolsStoneDetect,    pursue: toolsStonePursue },
	{ id: "armor_basic",     level: 5,  title: "Базовая броня",     detect: armorBasicDetect,    pursue: armorBasicPursue },
	{ id: "food_security",   level: 6,  title: "Запас еды",         detect: foodSecurityDetect,  pursue: foodSecurityPursue },
	{ id: "tools_iron",      level: 7,  title: "Железные орудия",   detect: toolsIronDetect,     pursue: toolsIronPursue },
	{ id: "armor_iron",      level: 8,  title: "Железная броня",    detect: armorIronDetect,     pursue: armorIronPursue },
	{ id: "village_seed",    level: 9,  title: "Зачаток деревни",   detect: villageSeedDetect,   pursue: villageSeedPursue },
	{ id: "village_full",    level: 10, title: "Полная деревня",    detect: villageFullDetect,   pursue: villageFullPursue },
]);

export function getNeed(id) {
	return NEEDS.find((n) => n.id === id) ?? null;
}

// Test exports
export const __testing = {
	hasAny, countAny, countLogs, countPlanks,
	FOOD_ITEMS, BED_ITEMS, ARMOR_CHEST_ANY,
};
