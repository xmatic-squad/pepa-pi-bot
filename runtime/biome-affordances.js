// Static knowledge: what each Minecraft biome reliably affords the bot.
//
// Why: pre-v0.3.1 the bot's "find food" skill scanned a 32-block radius
// for passive mobs and gave up. In a desert/ocean/snowy biome there's
// nothing to scan — the bot looped local searches for hours. This
// table lets skills check the *current* biome and pick a strategy
// before reaching for `pathfinder` blindly.
//
// Coverage is informed by vanilla mob spawn rules
// (https://minecraft.fandom.com/wiki/Spawn) — not exhaustive but
// covers the biomes the bot is realistically going to land in on
// 1.21.4 overworld spawn.
//
// Each entry is conservative: a `true` is "the bot has a real shot at
// finding this here", a `false` is "almost never bother scanning".

/**
 * Affordance shape:
 *   has_passive_mobs  — cows / pigs / chickens / sheep spawn here
 *   has_trees         — oak/birch/spruce/jungle logs grow naturally
 *   has_water         — open surface water that can be fished
 *   has_crops         — natural berries / pumpkins / melons / sweet_berry_bush
 *   livable           — bot can stand on the surface (not in lava, not
 *                       perpetually underwater)
 */
const DEFAULT = Object.freeze({
	has_passive_mobs: true,
	has_trees: false,
	has_water: false,
	has_crops: false,
	livable: true,
});

const BIOMES = Object.freeze({
	// Forest family — trees + cows/pigs/chickens
	forest:            { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	birch_forest:      { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	dark_forest:       { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: true,  livable: true },
	old_growth_birch_forest: { has_passive_mobs: true, has_trees: true, has_water: false, has_crops: false, livable: true },
	old_growth_pine_taiga:   { has_passive_mobs: true, has_trees: true, has_water: false, has_crops: true, livable: true },
	old_growth_spruce_taiga: { has_passive_mobs: true, has_trees: true, has_water: false, has_crops: true, livable: true },
	taiga:             { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: true,  livable: true },
	snowy_taiga:       { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	flower_forest:     { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	pale_garden:       { has_passive_mobs: false, has_trees: true,  has_water: false, has_crops: false, livable: true },

	// Plains family — open spawn, lots of mobs, scattered trees
	plains:            { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	sunflower_plains:  { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	meadow:            { has_passive_mobs: true,  has_trees: false, has_water: false, has_crops: false, livable: true },
	cherry_grove:      { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },

	// Savanna / jungle — passive mobs + trees
	savanna:           { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	savanna_plateau:   { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	windswept_savanna: { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	jungle:            { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: true,  livable: true },
	sparse_jungle:     { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	bamboo_jungle:     { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },

	// Swamp / mangrove — has water + berries
	swamp:             { has_passive_mobs: true,  has_trees: true,  has_water: true,  has_crops: false, livable: true },
	mangrove_swamp:    { has_passive_mobs: false, has_trees: true,  has_water: true,  has_crops: false, livable: true },

	// Desert / badlands — NO passive mobs, no trees, no surface water.
	// Action plan when the bot is here: walk a cardinal until biome
	// boundary is detected (sample bot.world.getBiome at radius 64).
	desert:            { has_passive_mobs: false, has_trees: false, has_water: false, has_crops: false, livable: true },
	badlands:          { has_passive_mobs: false, has_trees: false, has_water: false, has_crops: false, livable: true },
	eroded_badlands:   { has_passive_mobs: false, has_trees: false, has_water: false, has_crops: false, livable: true },
	wooded_badlands:   { has_passive_mobs: false, has_trees: true,  has_water: false, has_crops: false, livable: true },

	// Snowy biomes — no passive mobs (rabbits sometimes), strangled trees
	snowy_plains:      { has_passive_mobs: true,  has_trees: false, has_water: false, has_crops: false, livable: true },
	ice_spikes:        { has_passive_mobs: false, has_trees: false, has_water: false, has_crops: false, livable: true },
	frozen_river:      { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: true },
	frozen_ocean:      { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: false },
	deep_frozen_ocean: { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: false },

	// Mountains — sparse trees, goats
	stony_peaks:       { has_passive_mobs: true,  has_trees: false, has_water: false, has_crops: false, livable: true },
	jagged_peaks:      { has_passive_mobs: true,  has_trees: false, has_water: false, has_crops: false, livable: true },
	frozen_peaks:      { has_passive_mobs: true,  has_trees: false, has_water: false, has_crops: false, livable: true },
	snowy_slopes:      { has_passive_mobs: true,  has_trees: false, has_water: false, has_crops: false, livable: true },
	grove:             { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	windswept_hills:   { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },
	windswept_gravelly_hills: { has_passive_mobs: true, has_trees: false, has_water: false, has_crops: false, livable: true },
	windswept_forest:  { has_passive_mobs: true,  has_trees: true,  has_water: false, has_crops: false, livable: true },

	// Beaches / ocean — passive mobs scarce, water everywhere
	beach:             { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: true },
	stony_shore:       { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: true },
	snowy_beach:       { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: true },
	ocean:             { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: false },
	cold_ocean:        { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: false },
	deep_ocean:        { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: false },
	deep_cold_ocean:   { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: false },
	lukewarm_ocean:    { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: false },
	deep_lukewarm_ocean: { has_passive_mobs: false, has_trees: false, has_water: true, has_crops: false, livable: false },
	warm_ocean:        { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: false },
	river:             { has_passive_mobs: false, has_trees: false, has_water: true,  has_crops: false, livable: true },

	// Mushroom — mooshrooms only, no other passive mobs but they ARE food
	mushroom_fields:   { has_passive_mobs: true,  has_trees: false, has_water: false, has_crops: false, livable: true },

	// Caves / unsupported dimensions — bot should leave
	dripstone_caves:   { has_passive_mobs: false, has_trees: false, has_water: false, has_crops: false, livable: false },
	lush_caves:        { has_passive_mobs: false, has_trees: false, has_water: false, has_crops: true,  livable: false },
	deep_dark:         { has_passive_mobs: false, has_trees: false, has_water: false, has_crops: false, livable: false },
});

/**
 * affordancesFor(biomeName) → affordance object
 *
 * Unknown / null / undefined names return the optimistic DEFAULT so
 * skills don't get crippled when a new 1.x biome shows up; they just
 * fall back to the existing local-scan behaviour.
 */
export function affordancesFor(biomeName) {
	if (!biomeName || typeof biomeName !== "string") return DEFAULT;
	return BIOMES[biomeName] ?? DEFAULT;
}

export function hasPassiveMobs(biomeName) {
	return affordancesFor(biomeName).has_passive_mobs;
}
export function hasTrees(biomeName) {
	return affordancesFor(biomeName).has_trees;
}
export function hasWater(biomeName) {
	return affordancesFor(biomeName).has_water;
}
export function isLivable(biomeName) {
	return affordancesFor(biomeName).livable;
}

// True if this biome is barren enough that the bot's priority should
// be "leave biome" rather than "search local".
export function isBarren(biomeName) {
	const a = affordancesFor(biomeName);
	return !a.has_passive_mobs && !a.has_trees && !a.has_crops;
}

// True if the biome can't be stood on (deep ocean, caves at y=Y).
export function isUnlivable(biomeName) {
	return !affordancesFor(biomeName).livable;
}

// Test exports
export const __testing = { BIOMES, DEFAULT };
