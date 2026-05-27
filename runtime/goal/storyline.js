// Storyline — canonical Minecraft survival quest the bot lives inside.
//
// Why this exists (rationale, 2026-05-27 evening):
//
// After v0.3.0 went live the bot got stuck in a loop:
//   acquire-food (fail: no nearby food) → explore.far → pillar-up (fail) → repeat
//
// Manifesto + LLM advisor both correctly say "you need food" but
// neither expresses *what concretely to do next*: scout 64 blocks N
// for cows; chop oak nearby; place a crafting table. The bot has no
// narrative arc, just a priority ranking of unsatisfied needs.
//
// Storyline fixes this by laying down the classic vanilla Minecraft
// survival path as an ordered list of *concrete* steps. Each step
// owns:
//   - id, title, narration_ru (chat-friendly Russian one-liner)
//   - completed(snapshot) → bool — detects if this step's goal has
//     been achieved purely from snapshot
//   - suggestSkill(snapshot) → { skillId, args? } | null — the
//     concrete next dispatch for the step's pursuit
//   - emergencyPause(snapshot) → bool — true if a higher-priority
//     condition (low HP near hostile, lava under foot, etc.) means we
//     should drop story progression for a tick
//
// The runtime/goal/state.js picker walks the list and returns the
// first non-completed step, with its suggestSkill. That feeds into:
//   - reflex.js dispatch picking (storyline overrides curriculum, but
//     manifesto L0 alive emergencies still win)
//   - persona/chatter.js — narrates step start in MC chat
//   - coach/fast-advisor.js — user prompt includes current step so
//     the LLM advice is anchored in the actual narrative
//   - postmortem / reflect — the LLM can flag missing skills using
//     the current step as concrete context
//
// Storyline order mirrors manifesto levels but is more *operational*:
// where manifesto says "L2 tools_wood satisfied if you have a wood
// pickaxe", storyline says "step first_tools: place crafting table,
// craft wooden pickaxe + axe + sword, with these specific subgoals."

const PICKAXE_WOOD = new Set(["wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"]);
const AXE_WOOD = new Set(["wooden_axe", "stone_axe", "iron_axe", "diamond_axe", "netherite_axe"]);
const SWORD_WOOD = new Set(["wooden_sword", "stone_sword", "iron_sword", "diamond_sword", "netherite_sword"]);
const PICKAXE_STONE = new Set(["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"]);
const BED_ITEMS = [
	"white_bed", "orange_bed", "magenta_bed", "light_blue_bed", "yellow_bed",
	"lime_bed", "pink_bed", "gray_bed", "light_gray_bed", "cyan_bed",
	"purple_bed", "blue_bed", "brown_bed", "green_bed", "red_bed", "black_bed",
];
const FOOD_ITEMS = [
	"bread", "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton",
	"cooked_rabbit", "cooked_cod", "cooked_salmon", "baked_potato",
	"apple", "carrot", "potato", "beetroot", "melon_slice", "sweet_berries",
	"golden_apple", "golden_carrot",
];

function hasSetItem(inv, set) {
	if (!inv) return false;
	for (const name of Object.keys(inv)) {
		if (set.has(name) && inv[name] > 0) return true;
	}
	return false;
}

function hasAny(inv, names) {
	if (!inv) return false;
	for (const n of names) if ((inv[n] ?? 0) > 0) return true;
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

function emergencyPause(snap) {
	if (!snap?.connected) return false;
	const hp = snap.health ?? 20;
	const food = snap.food ?? 20;
	const hostile = snap.closestHostile;
	if (hp <= 5) return true;
	if (food <= 0) return true;
	if (hostile && (hostile.distance ?? Infinity) <= 5 && hp <= 12) return true;
	if (snap.hazards?.footBlock === "lava") return true;
	return false;
}

// ---------------------------------------------------------------------------

export const STORYLINE = Object.freeze([
	{
		id: "orient_self",
		title: "Понять где я",
		narration_ru: "Где я? Осмотрюсь и оценю место.",
		completed(snap) {
			if (!snap?.connected) return false;
			const hp = snap.health ?? 20;
			// Two completion paths: (a) classic — full HP + saw tangible
			// blocks within 16 blocks. (b) timeout — HP=full + session
			// >120s. Path (b) exists because in desert/ocean biomes the
			// scan radius might never see logs/stone/crops/beds, and we
			// were getting stuck on step 1 for hours.
			if (hp < 18) return false;
			const sawBlocks = (snap.nearbyBlocks?.logs ?? 0)
				+ (snap.nearbyBlocks?.stone ?? 0)
				+ (snap.nearbyBlocks?.crops ?? 0)
				+ (snap.nearbyBlocks?.beds ?? 0)
				> 0;
			if (sawBlocks) return true;
			// Fallback: settled for long enough → call orient done and let
			// later steps drive forward into the biome.
			const sessionMs = snap._sessionMs ?? 0;
			return sessionMs > 120_000;
		},
		suggestSkill(snap) {
			// Look around — wander a bit to get a snapshot of what's nearby.
			return { skillId: "explore.wander", args: { radius: 12 } };
		},
		emergencyPause,
	},

	{
		id: "first_wood",
		title: "Собрать 8 поленьев",
		narration_ru: "Цель: 8 поленьев. Иду рубить ближайшие деревья.",
		completed(snap) {
			return countLogs(snap?.inventory) >= 8;
		},
		suggestSkill(snap) {
			const trees = snap?.nearbyBlocks?.logs ?? 0;
			if (trees > 0) return { skillId: "gather.logs" };
			// No tree in sight — scout further. In a biome with no trees
			// (desert, ocean) the bot must commit to a long heading; the
			// curriculum's wedge detector (v0.3.1+) elevates this to
			// village.relocate after a few cycles.
			return { skillId: "explore.far", args: { searchFor: "logs" } };
		},
		emergencyPause,
	},

	{
		id: "crafting_basics",
		title: "Сделать верстак и палки",
		narration_ru: "Делаю верстак и палки — без них ничего не скрафтить.",
		completed(snap) {
			const inv = snap?.inventory ?? {};
			return (inv.crafting_table ?? 0) > 0
				&& (inv.stick ?? 0) >= 2
				&& countPlanks(inv) >= 4;
		},
		suggestSkill(snap) {
			const inv = snap?.inventory ?? {};
			if (countPlanks(inv) < 4) return { skillId: "craft.planks" };
			if ((inv.stick ?? 0) < 2) return { skillId: "craft.sticks" };
			// We have raw materials, need to *place* a crafting table for tools.
			// (No place-table skill yet — flagged as improvement_request elsewhere.)
			return { skillId: "craft.sticks" };
		},
		emergencyPause,
	},

	{
		id: "first_tools",
		title: "Деревянные орудия",
		narration_ru: "Крафчу деревянный пикакс, топор и меч.",
		completed(snap) {
			const inv = snap?.inventory ?? {};
			return hasSetItem(inv, PICKAXE_WOOD)
				&& hasSetItem(inv, AXE_WOOD)
				&& hasSetItem(inv, SWORD_WOOD);
		},
		suggestSkill(snap) {
			const inv = snap?.inventory ?? {};
			if (!hasSetItem(inv, PICKAXE_WOOD)) return { skillId: "craft.wooden-pickaxe" };
			if (!hasSetItem(inv, AXE_WOOD)) return { skillId: "craft.wooden-axe" };
			if (!hasSetItem(inv, SWORD_WOOD)) return { skillId: "craft.wooden-sword" };
			return null;
		},
		emergencyPause,
	},

	{
		id: "first_food",
		title: "Найти первую еду",
		narration_ru: "Нужна еда — ищу корову, курицу или ягоды.",
		completed(snap) {
			return countAny(snap?.inventory, FOOD_ITEMS) >= 2;
		},
		suggestSkill(snap) {
			// Two-tier strategy:
			//  - If a passive food mob is visible nearby (≤24 blocks in
			//    snapshot), kill it locally with acquire-food.
			//  - Otherwise scout-food does long-range biome-aware search.
			//    It commits to a cardinal for ~200 blocks, rescans, and
			//    on biome boundary detection heads toward food-capable
			//    terrain.
			const hasPassiveNearby = (snap?.nearbyEntities?.passives?.length ?? 0) > 0;
			if (hasPassiveNearby) return { skillId: "survive.acquire-food" };
			return { skillId: "survive.scout-food" };
		},
		emergencyPause,
	},

	{
		id: "shelter_minimal",
		title: "Простой шелтер с кроватью",
		narration_ru: "Поставлю кровать и стены — пережить ночь.",
		completed(snap) {
			return (snap?.nearbyBlocks?.beds ?? 0) > 0;
		},
		suggestSkill(snap) {
			const inv = snap?.inventory ?? {};
			if (!hasAny(inv, BED_ITEMS)) {
				const wool = countAny(inv, [
					"white_wool", "orange_wool", "magenta_wool", "light_blue_wool",
					"yellow_wool", "lime_wool", "pink_wool", "gray_wool",
					"light_gray_wool", "cyan_wool", "purple_wool", "blue_wool",
					"brown_wool", "green_wool", "red_wool", "black_wool",
				]);
				if (wool >= 3 && countPlanks(inv) >= 3) return { skillId: "craft.bed" };
				if (wool < 3) return { skillId: "gather.wool" };
			}
			return { skillId: "village.build-shelter" };
		},
		emergencyPause,
	},

	{
		id: "stone_tier",
		title: "Каменные орудия",
		narration_ru: "Шахта по камню — нужен каменный сет.",
		completed(snap) {
			return hasSetItem(snap?.inventory, PICKAXE_STONE);
		},
		suggestSkill(snap) {
			const inv = snap?.inventory ?? {};
			const cobble = inv.cobblestone ?? 0;
			if (cobble < 4) return { skillId: "gather.stone" };
			if ((inv.stick ?? 0) < 2) return { skillId: "craft.sticks" };
			if (!hasSetItem(inv, PICKAXE_STONE)) return { skillId: "craft.stone-pickaxe" };
			if (!hasAny(inv, ["stone_axe"])) return { skillId: "craft.stone-axe" };
			return { skillId: "craft.stone-sword" };
		},
		emergencyPause,
	},

	{
		id: "food_security",
		title: "Запас еды на 16+",
		narration_ru: "Делаю ферму или загон — еды должно быть с запасом.",
		completed(snap) {
			return countAny(snap?.inventory, FOOD_ITEMS) >= 16;
		},
		suggestSkill(snap) {
			const inv = snap?.inventory ?? {};
			if ((inv.wheat_seeds ?? 0) > 0 && (snap?.nearbyBlocks?.crops ?? 0) > 0) {
				return { skillId: "farm.wheat" };
			}
			return { skillId: "survive.acquire-food" };
		},
		emergencyPause,
	},

	{
		id: "iron_age",
		title: "Железо и печь",
		narration_ru: "Иду за железом — пора в шахту глубже.",
		completed(snap) {
			const inv = snap?.inventory ?? {};
			return (inv.iron_ingot ?? 0) >= 3 || (inv.iron_pickaxe ?? 0) > 0;
		},
		suggestSkill(snap) {
			// No iron-specific gather skill yet — operator-facing improvement.
			return { skillId: "gather.stone" };
		},
		emergencyPause,
	},

	{
		id: "settle_base",
		title: "Постоянная база",
		narration_ru: "Выбираю место под деревню — нужно нормальное основание.",
		completed(snap) {
			const nb = snap?.nearbyBlocks ?? {};
			return (nb.beds ?? 0) >= 1 && (nb.storage ?? 0) >= 1;
		},
		suggestSkill(snap) {
			const inv = snap?.inventory ?? {};
			if ((inv.chest ?? 0) === 0 && countPlanks(inv) >= 8) return { skillId: "craft.chest" };
			if ((inv.chest ?? 0) > 0) return { skillId: "village.place-chest" };
			return { skillId: "village.choose-base" };
		},
		emergencyPause,
	},

	{
		id: "village_grow",
		title: "Развивать деревню",
		narration_ru: "Стою на ногах — теперь строю по плану деревни.",
		completed() { return false; }, // ongoing — never auto-completes
		suggestSkill(snap) {
			const inv = snap?.inventory ?? {};
			if ((inv.chest ?? 0) > 0 && countAny(inv, FOOD_ITEMS) > 0) {
				return { skillId: "village.deposit-surplus" };
			}
			return { skillId: "village.build-shelter" };
		},
		emergencyPause,
	},
]);

export function getStep(id) {
	return STORYLINE.find((s) => s.id === id) ?? null;
}

// Test exports
export const __testing = {
	countLogs, countPlanks, countAny, hasAny, hasSetItem,
	FOOD_ITEMS, BED_ITEMS, emergencyPause,
};
