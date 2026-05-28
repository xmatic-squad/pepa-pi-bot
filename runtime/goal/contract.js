// Settlement Contract (L3) — the global goal as a typed, invariant-checked
// chain of milestones (research §2). This replaces the two competing
// progression rails (storyline quest + raw curriculum) with ONE ordered
// contract whose "done" is a fact about the world, not a guess.
//
// Each milestone:
//   id          stable string
//   title       human label (TUI / diary)
//   invariants  [{ id, describe, met(world) }]  — milestone is "met" iff all hold
//   suggest     (world) -> { skillId, args? } | null   — next concrete action
//   urgency?    (world) -> number   — utility boost so survival-critical
//               milestones (food) can preempt a lower-indexed unmet milestone
//
// The early tech-tree milestones delegate `suggest` to the proven
// deterministic curriculum (runtime/curriculum.js) so we reuse its careful
// chop→craft→tool chain instead of duplicating it. The contract owns ordering,
// invariant truth, observability and the late-game milestones curriculum lacks.

import { nextMilestone as curriculumNext } from "../curriculum.js";
import {
	alive,
	foodSecure,
	bedSecured,
	stoneTier,
	locationExists,
	hasItem,
	has,
	WOODEN_TOOLS,
	totalMatching,
} from "./invariants.js";

// curriculum's plan for the current snapshot. Prefer the plan bot.js already
// precomputed onto snapshot.curriculum (single source, no double-walk); fall
// back to recomputing when it is absent (unit tests, late-game). Returns null
// when curriculum is exhausted — the late-game contract takes over.
function curriculumPlan(world) {
	const pre = world.snapshot?.curriculum?.plan;
	if (pre && pre.skillId) return pre;
	try {
		return curriculumNext(world.snapshot)?.plan ?? null;
	} catch {
		return null;
	}
}

const FOOD_MOBS = new Set(["cow", "pig", "chicken", "sheep", "rabbit", "mooshroom"]);
function hasVisibleFoodTarget(world) {
	const passives = world.nearbyEntities?.passives ?? [];
	if (passives.some((e) => FOOD_MOBS.has(e.name))) return true;
	return (world.nearbyEntities?.droppedItems?.length ?? 0) > 0;
}

// Wooden tools acquired, OR already advanced to stone tier (monotonic: don't
// regress to "go chop wood" after the bot burned its logs into tools).
const woodenOrStoneTier = {
	id: "tool_tier",
	describe: "wooden tools (or already stone tier)",
	met: (w) =>
		WOODEN_TOOLS.every((n) => has(w.inventory, n)) ||
		totalMatching(w.inventory, (k) => /^stone_(axe|pickaxe|sword)$/.test(k)) > 0,
};

// A wheat farm is established. We mark it via a `farm` location (set by the
// farm skill) or by carrying harvested wheat as a fallback proxy.
const farmEstablished = {
	id: "farm",
	describe: "a wheat farm location or harvested wheat",
	met: (w) => !!w.locations?.farm || has(w.inventory, "wheat", 3),
};

export const SETTLEMENT_CONTRACT = Object.freeze([
	{
		id: "M0_alive",
		title: "Stay alive",
		invariants: [alive()],
		suggest: () => null, // survival layer (modes/manifesto) owns HP emergencies
	},
	{
		id: "M1_wood_tools",
		title: "Wooden tools",
		invariants: [woodenOrStoneTier],
		suggest: curriculumPlan,
	},
	{
		id: "M2_bed",
		title: "A bed to skip the night",
		invariants: [bedSecured()],
		suggest: curriculumPlan,
	},
	{
		id: "M3_stone_tools",
		title: "Stone tools + furnace",
		invariants: [stoneTier()],
		suggest: curriculumPlan,
	},
	{
		id: "M4_food_security",
		title: "Secure food",
		invariants: [foodSecure()],
		// Direct suggest (NOT curriculum): when food urgency preempts a lower
		// milestone, the strictly-ordered curriculum would still return the
		// wood step. We want the food action now.
		suggest: (w) => ({ skillId: hasVisibleFoodTarget(w) ? "survive.acquire-food" : "survive.scout-food" }),
		// Starving preempts lower-indexed progression: go eat/hunt now.
		urgency: (w) => (w.food < 8 ? 100 : w.food < 12 ? 20 : 0),
	},
	{
		id: "M5_storage",
		title: "A personal chest",
		invariants: [locationExists("chest")],
		suggest: curriculumPlan,
	},
	{
		id: "M6_lighting",
		title: "Torches for the perimeter",
		invariants: [hasItem("torch", 4, "torch")],
		suggest: curriculumPlan,
	},
	{
		id: "M7_base_site",
		title: "Pick a base site",
		invariants: [locationExists("base")],
		suggest: curriculumPlan,
	},
	{
		id: "M8_shelter",
		title: "Build a shelter",
		invariants: [locationExists("shelter")],
		suggest: curriculumPlan,
	},
	// ---- beyond the curriculum: late-game settlement work ----
	{
		id: "M9_farm",
		title: "Start a wheat farm",
		invariants: [farmEstablished],
		suggest: (w) => {
			// Deposit first if we're drowning in surplus and have a chest.
			const distinct = Object.keys(w.inventory ?? {}).length;
			if (distinct >= 30 && w.locations?.chest) return { skillId: "village.deposit-surplus" };
			return { skillId: "farm.wheat" };
		},
	},
]);

export function listContractMilestones() {
	return SETTLEMENT_CONTRACT.map((m) => ({ id: m.id, title: m.title }));
}

export const _internal = { woodenOrStoneTier, farmEstablished, curriculumPlan };
