// Invariant predicate library (L3).
//
// The research's core diagnosis: the bot picks plausible tasks but never
// asserts whether the world actually moved toward a settlement, so "progress"
// is replaced by noise. The fix is a typed contract whose milestones each
// carry INVARIANTS — boolean predicates over an authoritative world view — so
// "are we done with this milestone" is a fact about the world, not a guess.
//
// A predicate is a plain object: { id, describe, met(world) -> boolean }.
// `world` is the normalised view produced by worldFromSnapshot(): it exposes
// inventory (name->count), locations, health/food, daylight and an optional
// InventoryLedger. Predicates are PURE — they never touch the bot or disk.

// ---- world view ------------------------------------------------------------

export function worldFromSnapshot(snapshot, extra = {}) {
	const s = snapshot ?? {};
	return {
		snapshot: s,
		inventory: s.inventory ?? {},
		locations: s.locations ?? {},
		health: s.health ?? 20,
		food: s.food ?? 20,
		hasFood: !!s.hasFood,
		isDay: s.isDay !== false,
		position: s.position ?? null,
		nearbyBlocks: s.nearbyBlocks ?? {},
		nearbyEntities: s.nearbyEntities ?? {},
		closestHostile: s.closestHostile ?? null,
		ledger: extra.ledger ?? null,
	};
}

// ---- inventory helpers (shared with the contract) --------------------------

export function totalMatching(inv, matcher) {
	const f =
		typeof matcher === "function"
			? matcher
			: matcher instanceof RegExp
				? (k) => matcher.test(k)
				: (k) => k === matcher;
	let sum = 0;
	for (const [k, n] of Object.entries(inv ?? {})) if (f(k)) sum += n;
	return sum;
}

export function totalLogs(inv) {
	return totalMatching(inv, (k) => k.endsWith("_log") || k.endsWith("_stem"));
}
export function totalPlanks(inv) {
	return totalMatching(inv, (k) => k.endsWith("_planks"));
}
export function totalCobble(inv) {
	return (inv?.cobblestone ?? 0) + (inv?.cobbled_deepslate ?? 0);
}
export function totalWool(inv) {
	return totalMatching(inv, (k) => k.endsWith("_wool"));
}
export function maxSingleColourWool(inv) {
	let best = 0;
	for (const [k, n] of Object.entries(inv ?? {})) {
		if (k.endsWith("_wool") && n > best) best = n;
	}
	return best;
}
export function hasAnyBed(inv) {
	return totalMatching(inv, (k) => k.endsWith("_bed")) > 0;
}
export function has(inv, name, n = 1) {
	return (inv?.[name] ?? 0) >= n;
}

export const WOODEN_TOOLS = ["wooden_axe", "wooden_pickaxe", "wooden_sword"];
export const STONE_TOOLS = ["stone_axe", "stone_pickaxe", "stone_sword"];
export const COOKED_FOODS = [
	"bread", "cooked_beef", "cooked_chicken", "cooked_porkchop",
	"cooked_mutton", "cooked_rabbit", "baked_potato", "apple",
	"carrot", "potato", "cooked_cod", "cooked_salmon",
];

// ---- predicate builders ----------------------------------------------------

export function alive() {
	return { id: "alive", describe: "health > 0", met: (w) => w.health > 0 };
}

export function healthAtLeast(n) {
	return { id: `health>=${n}`, describe: `health at least ${n}`, met: (w) => w.health >= n };
}

export function foodAtLeast(n) {
	return { id: `food>=${n}`, describe: `hunger at least ${n}`, met: (w) => w.food >= n };
}

// "Food security": carrying edible food, or well-fed, or holding a cooked
// staple. We cannot introspect chest contents from the snapshot, so this is
// the observable proxy for research M1's `food_stock>=5_in_chest`.
export function foodSecure() {
	return {
		id: "food_secure",
		describe: "carrying edible food or well-fed",
		met: (w) => w.hasFood || w.food >= 18 || COOKED_FOODS.some((n) => has(w.inventory, n)),
	};
}

export function hasAllItems(names) {
	return {
		id: `has_all:${names.join(",")}`,
		describe: `carrying all of ${names.join(", ")}`,
		met: (w) => names.every((n) => has(w.inventory, n)),
	};
}

export function hasItem(matcher, n = 1, label = null) {
	return {
		id: `has:${label ?? String(matcher)}>=${n}`,
		describe: `at least ${n}× ${label ?? String(matcher)}`,
		met: (w) => totalMatching(w.inventory, matcher) >= n,
	};
}

export function woodenTier() {
	return {
		id: "wooden_tier",
		describe: "wooden axe + pickaxe + sword",
		met: (w) => WOODEN_TOOLS.every((n) => has(w.inventory, n)),
	};
}

export function stoneTier() {
	return {
		id: "stone_tier",
		describe: "stone axe + pickaxe + sword + furnace",
		met: (w) => STONE_TOOLS.every((n) => has(w.inventory, n)) && has(w.inventory, "furnace"),
	};
}

export function bedSecured() {
	return {
		id: "bed",
		describe: "a bed on hand or a placed bed location",
		met: (w) => hasAnyBed(w.inventory) || !!w.locations.bed,
	};
}

// A named location exists in locations.json (set by the skill that builds it:
// village.choose-base → base, build-shelter → shelter, place-chest → chest).
export function locationExists(kind) {
	return {
		id: `loc:${kind}`,
		describe: `a known ${kind} location`,
		met: (w) => !!w.locations?.[kind],
	};
}

// ---- checker ---------------------------------------------------------------

// Evaluate every invariant of a milestone against the world. Returns
// { met, unmet: [ids], evidence: { [id]: bool } } so the GoalManager can pick
// the lowest unmet milestone and the TUI can show *which* invariant is open.
export function checkInvariants(milestone, world) {
	const invs = milestone?.invariants ?? [];
	const evidence = {};
	const unmet = [];
	for (const inv of invs) {
		let ok = false;
		try {
			ok = !!inv.met(world);
		} catch {
			ok = false;
		}
		evidence[inv.id] = ok;
		if (!ok) unmet.push(inv.id);
	}
	return { met: unmet.length === 0, unmet, evidence };
}
