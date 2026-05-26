// Modes priority chain — adapted from Mindcraft modes.js.
//
// A mode is `{ name, interrupts, on, active, update(ctx) }`. Each
// reflex tick the scheduler walks the modes in order BEFORE dispatching
// the curriculum-suggested skill. The first mode whose `update()`
// returns `{ action, interrupts }` wins: if interrupts.includes("all")
// the curriculum skill for this tick is cancelled, and the mode's
// returned action is dispatched instead.
//
// Why: today's `reflex.js` mixes panic responses (flee, eat, sleep)
// with the long-tail curriculum logic and uses ad-hoc cooldowns
// (`lastFleeAttempt`, `lastEatAt`). The Mindcraft shape is cleaner:
// declarative interrupts, explicit on/active state, and the same loop
// covers self_preservation (drowning/lava/low-HP), hunger, and night
// shelter. We start small — only the three modes we actually need —
// and let new modes register via `registerMode()` so new skills can
// hook in without editing this file.

const modes = [];

export function registerMode(mode) {
	if (!mode || typeof mode.name !== "string") throw new Error("mode: missing name");
	if (typeof mode.update !== "function") throw new Error(`mode ${mode.name}: missing update`);
	const existing = modes.findIndex((m) => m.name === mode.name);
	const filled = {
		on: mode.on ?? true,
		active: false,
		interrupts: mode.interrupts ?? [],
		...mode,
	};
	if (existing >= 0) modes[existing] = filled;
	else modes.push(filled);
}

export function listModes() {
	return modes.map((m) => ({ name: m.name, on: m.on, active: m.active, interrupts: m.interrupts }));
}

export function setModeEnabled(name, on) {
	const m = modes.find((x) => x.name === name);
	if (m) m.on = !!on;
}

// Reset for tests — keeps the priority list, just drops registrations.
export function _resetModes() { modes.length = 0; }

// Run every enabled mode in order until one returns a non-null result.
// Sync — modes are observational over a snapshot, no await. Anything
// long-running belongs in the skill the mode dispatches.
export function tickModes(ctx) {
	for (const m of modes) {
		if (!m.on) continue;
		let res = null;
		try {
			res = m.update(ctx);
		} catch (e) {
			res = null;
		}
		if (res?.action) {
			m.active = true;
			return {
				mode: m.name,
				action: res.action,
				interrupts: res.interrupts ?? m.interrupts,
				detail: res.detail ?? null,
			};
		}
		m.active = false;
	}
	return null;
}

// --- Standard modes registered at module load. Callers can override
// any of these by calling registerMode() with the same name. -----------

registerMode({
	name: "self_preservation",
	description: "Low HP, lava, drowning — drop the curriculum, flee or eat",
	interrupts: ["all"],
	update(ctx) {
		const snap = ctx?.snapshot;
		if (!snap) return null;
		const hp = snap.health ?? 20;
		const food = snap.food ?? 20;
		// HP critically low + we have food → eat NOW
		if (hp < 6 && food > 0 && snap.hasFood) {
			return { action: { skillId: "eat" }, detail: { reason: "hp<6", hp } };
		}
		// Hostile within reach and HP low → flee
		const ch = snap.closestHostile;
		if (ch && typeof ch.distance === "number" && ch.distance < 6 && hp < 10) {
			return { action: { skillId: "explore.far" }, detail: { reason: "hp<10 near-hostile", hp, dist: ch.distance } };
		}
		return null;
	},
});

registerMode({
	name: "hunger",
	description: "Eat proactively when food bar dips below 14",
	interrupts: ["curriculum"],
	update(ctx) {
		const snap = ctx?.snapshot;
		if (!snap) return null;
		if ((snap.food ?? 20) < 14 && snap.hasFood) {
			return { action: { skillId: "eat" }, detail: { reason: "food<14", food: snap.food } };
		}
		return null;
	},
});

registerMode({
	name: "night_shelter",
	description: "After dusk, sleep in or place a bed so player night-skip works",
	interrupts: ["curriculum"],
	update(ctx) {
		const snap = ctx?.snapshot;
		if (!snap) return null;
		// Only at night and only if we actually carry / can place a bed
		if (snap.isDay) return null;
		const inv = snap.inventory || {};
		const hasBed = Object.keys(inv).some((n) => /_bed$/.test(n));
		if (!hasBed) return null;
		return { action: { skillId: "sleep" }, detail: { reason: "night with bed in hand" } };
	},
});
