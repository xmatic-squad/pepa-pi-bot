// Deterministic early-game survival curriculum. Mirrors PRD §6 FR4:
// the bot should be able to progress from empty inventory to wooden tools,
// to a stone tier + furnace + chest, without an LLM call per tick.
//
// Each milestone exposes:
//   id        - stable string, used for diary/snapshot
//   title     - human label, used by TUI
//   isDone    - (inventoryCounts, snapshot) => boolean
//   suggest   - (inventoryCounts, snapshot) => skill plan
//                where a plan is { skillId, args? } or null if the
//                milestone requires a precondition the scheduler must
//                set up via an earlier milestone.
//
// The chooser walks milestones in order and returns the first one whose
// `isDone` returns false. That milestone is "current". Its `suggest()`
// tells the scheduler what skill to dispatch right now.
//
// The curriculum is pure: it never touches the bot, the world or the
// state-store. The scheduler is responsible for dispatch, retries and
// no-progress handling.

const INVENTORY_FULL_DISTINCT_STACKS = 32;

function totalLogs(inv) {
	return Object.entries(inv ?? {})
		.filter(([k]) => k.endsWith("_log") || k.endsWith("_stem"))
		.reduce((sum, [, n]) => sum + n, 0);
}

function totalPlanks(inv) {
	return Object.entries(inv ?? {})
		.filter(([k]) => k.endsWith("_planks"))
		.reduce((sum, [, n]) => sum + n, 0);
}

function totalCobble(inv) {
	return (inv?.cobblestone ?? 0) + (inv?.cobbled_deepslate ?? 0);
}

function has(inv, name, n = 1) {
	return (inv?.[name] ?? 0) >= n;
}

function hasAny(inv, names) {
	return names.some((n) => (inv?.[n] ?? 0) > 0);
}

const WOODEN_TOOLS = ["wooden_axe", "wooden_pickaxe", "wooden_sword"];
const STONE_TOOLS = ["stone_axe", "stone_pickaxe", "stone_sword"];

// A "stage reached" predicate: once the bot has wooden tools, wood.16 is
// implicitly considered done even if the log stack is now empty (the bot
// burned through them to craft planks/sticks/tools). Without this, the
// curriculum oscillates: chop → craft → "oh, I have no logs again, go
// chop". Each milestone keeps its raw-resource predicate AND an
// "advanced past this tier" escape so the chooser monotonically advances.
function hasWoodenTier(inv) {
	return WOODEN_TOOLS.some((n) => has(inv, n));
}
function hasStoneTier(inv) {
	return STONE_TOOLS.some((n) => has(inv, n));
}

const MILESTONES = [
	{
		id: "wood.16",
		title: "Gather 16 logs",
		isDone: (inv) => totalLogs(inv) >= 16 || hasWoodenTier(inv),
		suggest: () => ({ skillId: "gather.logs" }),
	},
	{
		id: "wood.planks-and-sticks",
		title: "Craft 4 planks and 4 sticks",
		isDone: (inv) =>
			(totalPlanks(inv) >= 4 && has(inv, "stick", 4)) || hasWoodenTier(inv),
		suggest: (inv) => {
			if (totalPlanks(inv) < 4) return { skillId: "craft.planks" };
			return { skillId: "craft.sticks" };
		},
	},
	{
		id: "wood.tools",
		title: "Craft wooden axe, pickaxe, sword",
		isDone: (inv) => WOODEN_TOOLS.every((n) => has(inv, n)) || hasStoneTier(inv),
		suggest: (inv) => {
			if (!has(inv, "wooden_axe")) return { skillId: "craft.wooden-axe" };
			if (!has(inv, "wooden_pickaxe")) return { skillId: "craft.wooden-pickaxe" };
			if (!has(inv, "wooden_sword")) return { skillId: "craft.wooden-sword" };
			return null;
		},
	},
	{
		id: "stone.32",
		title: "Gather 32 cobblestone",
		isDone: (inv) => totalCobble(inv) >= 32 || hasStoneTier(inv),
		suggest: () => ({ skillId: "gather.stone" }),
	},
	{
		id: "stone.tools",
		title: "Craft stone axe, pickaxe, sword and a furnace",
		isDone: (inv) => STONE_TOOLS.every((n) => has(inv, n)) && has(inv, "furnace"),
		suggest: (inv) => {
			if (!has(inv, "stone_axe")) return { skillId: "craft.stone-axe" };
			if (!has(inv, "stone_pickaxe")) return { skillId: "craft.stone-pickaxe" };
			if (!has(inv, "stone_sword")) return { skillId: "craft.stone-sword" };
			if (!has(inv, "furnace")) return { skillId: "craft.furnace" };
			return null;
		},
	},
	{
		id: "food.basic",
		title: "Secure a basic food source",
		isDone: (inv, snap) => {
			const carrying = ["bread", "cooked_beef", "cooked_chicken", "cooked_porkchop", "apple", "carrot", "potato", "baked_potato"].some(
				(n) => has(inv, n),
			);
			return carrying || (snap?.food ?? 20) >= 18;
		},
		suggest: () => ({ skillId: "survive.eat" }), // best-effort; richer "find food" skill lands later
	},
	{
		id: "storage.chest",
		title: "Place a personal chest",
		isDone: (inv) => has(inv, "chest"),
		suggest: () => ({ skillId: "craft.chest" }),
	},
	{
		id: "shelter.torch",
		title: "Have torches on hand for the perimeter",
		isDone: (inv) => has(inv, "torch", 4),
		suggest: () => ({ skillId: "craft.torch" }),
	},
	{
		id: "village.base-site",
		title: "Pick a base site",
		// We treat this as done when a "base" location exists in
		// locations.json. The curriculum can't read that file from here
		// (would couple it to disk), so we expose a snapshot hint:
		// `snapshot.locations?.base` is filled by bot.js.
		isDone: (_inv, snap) => !!snap?.locations?.base,
		suggest: () => ({ skillId: "village.choose-base" }),
	},
];

export function isInventoryFull(snapshot) {
	const distinct = Object.keys(snapshot?.inventory ?? {}).length;
	return distinct >= INVENTORY_FULL_DISTINCT_STACKS;
}

// Walk the curriculum and return the first uncompleted milestone, plus
// the suggested skill for it. If the inventory is full, the scheduler may
// choose to insert a deposit/drop step before continuing; we mark that
// in the result rather than skipping the milestone so the TUI can show
// the right blocker.
export function nextMilestone(snapshot) {
	const inv = snapshot?.inventory ?? {};
	for (const m of MILESTONES) {
		if (m.isDone(inv, snapshot)) continue;
		const plan = m.suggest(inv, snapshot);
		return {
			milestone: { id: m.id, title: m.title },
			plan,
			inventoryFull: isInventoryFull(snapshot),
		};
	}
	return null; // every milestone done — bot has reached the end of the
	// deterministic curriculum and base/village logic takes over (Phase 4).
}

export function listMilestones() {
	return MILESTONES.map((m) => ({ id: m.id, title: m.title }));
}

// Exposed for tests.
export const _internal = { totalLogs, totalPlanks, totalCobble, has, hasAny, MILESTONES };
