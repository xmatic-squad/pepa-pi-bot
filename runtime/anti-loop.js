// Anti-loop detector (QW5). The scheduler already skips a (skill, situation)
// that has failed repeatedly (scenario-memory.shouldSkip), but that is keyed on
// a coarse situation hash and never escalates. This detector closes the loop
// the research describes: when the SAME skill fails N times inside a short
// window with no success in between, it (a) blacklists that skill for a cool-off
// and (b) emits a one-shot "fired" record the runtime turns into an
// improvement_request — so an operator/Codex gets a ticket instead of the bot
// silently thrashing (e.g. the live flee↔dig-in loop we observed).
//
// Pure + deterministic: inject `now` in tests. No disk, no bot.

export function createAntiLoop({
	windowMs = 5 * 60_000,
	threshold = 3,
	blacklistMs = 30 * 60_000,
	refireCooldownMs = 30 * 60_000,
} = {}) {
	const state = new Map(); // key -> { fails: number[], blacklistUntil, lastFiredAt }
	const firedQueue = [];

	function keyOf(skillId, targetKey) {
		return targetKey ? `${skillId}@${targetKey}` : skillId;
	}
	function get(key) {
		let s = state.get(key);
		// lastFiredAt = -Infinity so the FIRST loop always fires (a real epoch
		// `now` minus 0 would otherwise be < refireCooldownMs early in uptime).
		if (!s) { s = { fails: [], blacklistUntil: 0, lastFiredAt: Number.NEGATIVE_INFINITY }; state.set(key, s); }
		return s;
	}

	function record({ skillId, ok, code = null, targetKey = null, detail = null, now = Date.now() }) {
		if (!skillId) return { fired: false };
		const key = keyOf(skillId, targetKey);
		const s = get(key);
		if (ok) { s.fails = []; return { fired: false }; }

		s.fails.push(now);
		s.fails = s.fails.filter((t) => now - t <= windowMs);

		if (s.fails.length >= threshold) {
			s.blacklistUntil = now + blacklistMs;
			const count = s.fails.length;
			s.fails = []; // reset streak so we don't blacklist-spam every further fail
			if (now - s.lastFiredAt >= refireCooldownMs) {
				s.lastFiredAt = now;
				const fired = { key, skillId, targetKey, count, code, detail, ts: now, until: s.blacklistUntil };
				firedQueue.push(fired);
				return { fired: true, ...fired };
			}
		}
		return { fired: false };
	}

	function shouldSkip(skillId, targetKey = null, now = Date.now()) {
		const s = state.get(keyOf(skillId, targetKey));
		return !!s && now < s.blacklistUntil;
	}

	// Returns and clears the queue of newly-fired loops (for improvement_requests).
	function drainFired() {
		return firedQueue.splice(0);
	}

	function snapshot() {
		return { tracked: state.size, pendingFired: firedQueue.length };
	}

	return { record, shouldSkip, drainFired, snapshot, _state: () => state };
}
