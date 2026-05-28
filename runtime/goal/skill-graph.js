// Skill dependency graph (Plan4MC-style, research §C). A static, declarative
// model of "what does this skill need, what does it produce". The contract
// already SEQUENCES the early game via the curriculum, so this graph is the
// queryable prerequisite layer on top: the GoalManager annotates each suggested
// skill with whether its prerequisites currently hold (surfaced for the TUI and
// as a guard against suggesting a skill that physically cannot succeed here).
//
// Requirement kinds:
//   { item: <semantic-group|exact>, min }   — need N of an item / group
//   { tool: "pickaxe" | "axe" | "sword" }     — need any tier of that tool
// Semantic groups: logs (*_log/_stem), planks (*_planks), sticks, cobblestone,
// wool (*_wool), coal, bed (*_bed). Anything else is matched as an exact name.

import { totalMatching, has } from "./invariants.js";

const GROUP = {
	logs: (k) => k.endsWith("_log") || k.endsWith("_stem"),
	planks: (k) => k.endsWith("_planks"),
	wool: (k) => k.endsWith("_wool"),
	cobblestone: (k) => k === "cobblestone" || k === "cobbled_deepslate",
	coal: (k) => k === "coal" || k === "charcoal",
};

const TOOL = {
	pickaxe: (k) => k.endsWith("_pickaxe"),
	axe: (k) => k.endsWith("_axe") && !k.endsWith("_pickaxe"),
	sword: (k) => k.endsWith("_sword"),
};

export const SKILL_GRAPH = Object.freeze({
	"gather.logs": { requires: [], produces: ["logs"] },
	"gather.wool": { requires: [], produces: ["wool"] },
	"gather.stone": { requires: [{ tool: "pickaxe" }], produces: ["cobblestone"] },
	"craft.planks": { requires: [{ item: "logs", min: 1 }], produces: ["planks"] },
	"craft.sticks": { requires: [{ item: "planks", min: 2 }], produces: ["stick"] },
	"craft.wooden-axe": { requires: [{ item: "planks", min: 3 }, { item: "stick", min: 2 }], produces: ["wooden_axe"] },
	"craft.wooden-pickaxe": { requires: [{ item: "planks", min: 3 }, { item: "stick", min: 2 }], produces: ["wooden_pickaxe"] },
	"craft.wooden-sword": { requires: [{ item: "planks", min: 2 }, { item: "stick", min: 1 }], produces: ["wooden_sword"] },
	"craft.stone-axe": { requires: [{ item: "cobblestone", min: 3 }, { item: "stick", min: 2 }], produces: ["stone_axe"] },
	"craft.stone-pickaxe": { requires: [{ item: "cobblestone", min: 3 }, { item: "stick", min: 2 }], produces: ["stone_pickaxe"] },
	"craft.stone-sword": { requires: [{ item: "cobblestone", min: 2 }, { item: "stick", min: 1 }], produces: ["stone_sword"] },
	"craft.furnace": { requires: [{ item: "cobblestone", min: 8 }], produces: ["furnace"] },
	"craft.chest": { requires: [{ item: "planks", min: 8 }], produces: ["chest"] },
	"craft.torch": { requires: [{ item: "coal", min: 1 }, { item: "stick", min: 1 }], produces: ["torch"] },
	"craft.bed": { requires: [{ item: "wool", min: 3 }, { item: "planks", min: 3 }], produces: ["bed"] },
	"village.choose-base": { requires: [], produces: ["loc:base"] },
	"village.build-shelter": { requires: [{ item: "planks", min: 1 }], produces: ["loc:shelter"] },
	"village.place-chest": { requires: [{ item: "chest", min: 1 }], produces: ["loc:chest"] },
	"farm.wheat": { requires: [], produces: [] },
});

function itemCount(inv, name) {
	const g = GROUP[name];
	return g ? totalMatching(inv, g) : (inv?.[name] ?? 0);
}

function hasTool(inv, kind) {
	const t = TOOL[kind];
	if (!t) return false;
	return Object.keys(inv ?? {}).some((k) => t(k) && (inv[k] ?? 0) > 0);
}

// { ok, missing: [{ item|tool, min, have }] } for a skill given the world.
export function prerequisitesMet(skillId, world) {
	const node = SKILL_GRAPH[skillId];
	if (!node) return { ok: true, missing: [], known: false };
	const inv = world?.inventory ?? {};
	const missing = [];
	for (const req of node.requires) {
		if (req.tool) {
			if (!hasTool(inv, req.tool)) missing.push({ tool: req.tool });
		} else if (req.item) {
			const have = itemCount(inv, req.item);
			if (have < (req.min ?? 1)) missing.push({ item: req.item, min: req.min ?? 1, have });
		}
	}
	return { ok: missing.length === 0, missing, known: true };
}

export function canRun(skillId, world) {
	return prerequisitesMet(skillId, world).ok;
}

// All skills whose prerequisites currently hold (Plan4MC "frontier").
export function runnableFrontier(world) {
	return Object.keys(SKILL_GRAPH).filter((id) => canRun(id, world));
}

export const _internal = { GROUP, TOOL, itemCount, hasTool, has };
