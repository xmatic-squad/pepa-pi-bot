// Movement safety profiles. mineflayer-pathfinder's Movements object
// is shared per-bot — if one skill sets canDig=false and another
// inherits that, you get the live regression from earlier: flee with
// canDig=false leaves the bot stuck in a tree canopy forever.
//
// Each named profile is a flat descriptor (pure JS object) that the
// caller can either inspect directly (tests do this) or apply to a
// pathfinder Movements via applyProfile(profile, bot).

import pathfinderPkg from "mineflayer-pathfinder";
const { Movements } = pathfinderPkg;

export const PROFILES = Object.freeze({
	GATHER: "gather",
	TRAVEL: "travel",
	FLEE: "flee",
	BUILD: "build",
	RETURN_TO_BASE: "return_to_base",
});

// Pure descriptors — safe to import without a live bot.
export const PROFILE_DEFAULTS = Object.freeze({
	[PROFILES.GATHER]: { canDig: true, canPlace: false, allow1by1towers: false },
	[PROFILES.TRAVEL]: { canDig: true, canPlace: false, allow1by1towers: false },
	// canDig:true on flee is deliberate — observed live: flee with canDig=false
	// in dense canopy leaves the bot perched in leaves indefinitely.
	[PROFILES.FLEE]: { canDig: true, canPlace: false, allow1by1towers: false, maxDropDown: 8 },
	// Build: don't accidentally mine the structure we're placing; allow
	// 1x1 step-ups so shelter blueprints can layer.
	[PROFILES.BUILD]: { canDig: false, canPlace: true, allow1by1towers: true },
	// Return: don't carve tunnels home or place stepping blocks; just walk.
	[PROFILES.RETURN_TO_BASE]: { canDig: false, canPlace: false, allow1by1towers: false },
});

export function describeProfile(profile) {
	const desc = PROFILE_DEFAULTS[profile];
	if (!desc) throw new Error(`unknown movement profile: ${profile}`);
	return desc;
}

// Build a fresh Movements applying the descriptor; does NOT call setMovements.
export function buildProfile(profile, bot) {
	const desc = describeProfile(profile);
	const m = new Movements(bot);
	for (const [k, v] of Object.entries(desc)) m[k] = v;
	return m;
}

// Convenience: build + apply.
export function applyProfile(profile, bot) {
	const m = buildProfile(profile, bot);
	bot.pathfinder.setMovements(m);
	return m;
}
