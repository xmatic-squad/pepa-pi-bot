// No-progress detector. Independent from exception-style failures: this
// watches whether the bot is producing any *observable* world change
// (movement or inventory change) over time, and, if not, emits a single
// stable reason code so TUI + diary + future Pi escalation can show one
// concrete answer to "why is the bot standing still?".
//
// Reason codes are deliberately stable strings so they can be diffed
// across versions, counted, and used by future skill triggers.

export const REASONS = Object.freeze({
	WAITING_FOR_DAY: "waiting_for_day",
	NIGHT_HOSTILE_NEARBY: "night_hostile_nearby",
	NO_FOOD_SOURCE: "no_food_source",
	NO_SAFE_PATH: "no_safe_path",
	NO_KNOWN_BASE: "no_known_base",
	INVENTORY_FULL: "inventory_full",
	PLANNER_EMPTY: "planner_empty",
	NO_REACHABLE_TARGET: "no_reachable_target",
	AWAITING_ACTION_COOLDOWN: "awaiting_action_cooldown",
});

const STILL_THRESHOLD_MS = 60_000;
const POS_EPSILON = 1.5;
const INVENTORY_FULL_SLOTS = 32; // 36 main slots; treat >=32 distinct stacks as full-ish

// Conservative food list — items the bot can safely consume right now via
// the eat reflex / mineflayer auto-eat lineage. Kept short on purpose: if
// the bot is "hungry but no food", we want to detect that even when the
// inventory has dirt and sticks.
const FOOD_NAMES = new Set([
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
	"cooked_chicken",
	"dried_kelp",
	"pumpkin_pie",
]);

function hasFood(inventory) {
	for (const name of Object.keys(inventory ?? {})) {
		if (FOOD_NAMES.has(name)) return true;
	}
	return false;
}

function inventoryKey(inventory) {
	const entries = Object.entries(inventory ?? {});
	if (entries.length === 0) return "";
	entries.sort(([a], [b]) => (a < b ? -1 : 1));
	return entries.map(([k, v]) => `${k}:${v}`).join("|");
}

function distinctStacks(inventory) {
	return Object.keys(inventory ?? {}).length;
}

function classify({ snapshot, ctx, planExists }) {
	if (!snapshot.isDay) {
		if (snapshot.closestHostile && snapshot.closestHostile.distance <= 16) {
			return REASONS.NIGHT_HOSTILE_NEARBY;
		}
		return REASONS.WAITING_FOR_DAY;
	}

	const food = snapshot.food ?? 20;
	if (food <= 6 && !hasFood(snapshot.inventory)) {
		return REASONS.NO_FOOD_SOURCE;
	}

	if (distinctStacks(snapshot.inventory) >= INVENTORY_FULL_SLOTS) {
		return REASONS.INVENTORY_FULL;
	}

	if (ctx?.noTreesUntil && Date.now() < ctx.noTreesUntil) {
		return REASONS.NO_REACHABLE_TARGET;
	}

	if (!planExists) return REASONS.PLANNER_EMPTY;

	return REASONS.AWAITING_ACTION_COOLDOWN;
}

export function createNoProgressDetector({ stillThresholdMs = STILL_THRESHOLD_MS } = {}) {
	let stillSince = null;
	let lastPos = null;
	let lastInvKey = "";

	function reset() {
		stillSince = null;
	}

	function detect({ snapshot, ctx, planExists = true, now = Date.now() }) {
		if (!snapshot?.connected) {
			reset();
			return null;
		}
		if (ctx?.busy) {
			reset();
			return null;
		}

		const pos = snapshot.position;
		const ik = inventoryKey(snapshot.inventory);
		const moved =
			!lastPos || !pos
				? lastPos !== pos
				: Math.hypot(pos.x - lastPos.x, pos.z - lastPos.z) > POS_EPSILON ||
				  Math.abs(pos.y - lastPos.y) > POS_EPSILON;
		const invChanged = ik !== lastInvKey;

		if (moved || invChanged) {
			lastPos = pos ? { ...pos } : null;
			lastInvKey = ik;
			stillSince = now;
			return null;
		}

		if (stillSince == null) {
			stillSince = now;
			return null;
		}

		if (now - stillSince < stillThresholdMs) return null;

		return classify({ snapshot, ctx, planExists });
	}

	return { detect, reset };
}
