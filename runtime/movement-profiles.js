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
//
// canDig is FALSE everywhere by default (2026-05-26). On the live server
// (play.xmatic.team 26.1.2+ViaBackwards 5.9.1) bot.dig silently fails —
// the packet ID table for protocol 775 is wrong in minecraft-data
// (mineflayer#3888) — so pathfinder would schedule paths through
// must-dig blocks the bot can't actually break, and we'd loop. Once
// 1.21.4 pin + lookAt+wait fix is verified live, we can re-enable
// canDig for gather/travel profiles.
export const PROFILE_DEFAULTS = Object.freeze({
	[PROFILES.GATHER]: { canDig: false, canPlace: false, allow1by1towers: false },
	[PROFILES.TRAVEL]: { canDig: false, canPlace: false, allow1by1towers: false },
	[PROFILES.FLEE]: { canDig: false, canPlace: false, allow1by1towers: false, maxDropDown: 8 },
	[PROFILES.BUILD]: { canDig: false, canPlace: true, allow1by1towers: true },
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
