// "Does this look like a player build?" heuristic. Pure function;
// caller passes a list of nearby blocks and an isOwned predicate.
//
// Approach (intentionally conservative — false positives are fine):
//   * Count the man-made blocks within the test set. Man-made =
//     processed wood, stone bricks, smooth stone, glass, wool, etc.
//     Things that don't naturally generate without effort.
//   * Count owned-by-this-bot blocks.
//   * If man-made density is high AND the area is not predominantly
//     owned by this bot → flag as player_build. The skill code
//     should refuse to dig/place there.
//
// We don't try to detect ages, signs, or claim plugins — heuristics
// only. The cost of false positives is "bot wandered around a
// rectangular hut", which is fine; the cost of false negatives is
// "bot griefed a player base", which is unacceptable.

const MAN_MADE_PREFIXES = [
	"_planks",
	"stone_bricks",
	"smooth_stone",
	"polished_",
	"chiseled_",
	"glass",
	"wool",
	"terracotta",
	"concrete",
	"sandstone_stairs",
	"_slab",
	"_stairs",
	"_fence",
	"_door",
	"_trapdoor",
	"crafting_table",
	"furnace",
	"chest",
	"barrel",
	"shulker_box",
	"anvil",
	"enchanting_table",
	"bookshelf",
	"ladder",
];

const MAN_MADE_EXACT = new Set([
	"crafting_table",
	"furnace",
	"chest",
	"barrel",
	"bookshelf",
	"anvil",
	"enchanting_table",
	"ladder",
	"bell",
	"lectern",
	"composter",
	"smoker",
	"blast_furnace",
	"loom",
	"cartography_table",
	"fletching_table",
	"stonecutter",
	"grindstone",
]);

export function isManMadeBlockName(name) {
	if (!name) return false;
	if (MAN_MADE_EXACT.has(name)) return true;
	return MAN_MADE_PREFIXES.some((p) => name.includes(p));
}

export function classifyArea({ blocks, isOwned, minSamples = 5, manMadeThreshold = 0.4 }) {
	if (!Array.isArray(blocks) || blocks.length < minSamples) {
		return { verdict: "insufficient_data", manMade: 0, owned: 0, total: blocks?.length ?? 0 };
	}
	let manMade = 0;
	let owned = 0;
	for (const b of blocks) {
		if (!b || !b.name) continue;
		if (isManMadeBlockName(b.name)) manMade++;
		if (b.position && typeof isOwned === "function" && isOwned(b.position)) owned++;
	}
	const total = blocks.length;
	const manMadeRatio = manMade / total;
	const ownedRatio = owned / total;
	if (manMadeRatio >= manMadeThreshold && ownedRatio < manMadeRatio * 0.6) {
		return { verdict: "player_build", manMade, owned, total, manMadeRatio, ownedRatio };
	}
	return { verdict: "natural_or_owned", manMade, owned, total, manMadeRatio, ownedRatio };
}

export function shouldAvoid(area) {
	return area?.verdict === "player_build";
}
