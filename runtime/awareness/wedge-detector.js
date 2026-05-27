// Wedge detector — rolling-10min position bounding box.
//
// Sits above the skill layer (per the v0.3.1 design research). The
// reflex calls observe() with the latest position once per tick; on
// every call we evict older entries and recompute the bbox over the
// trailing window. If the bbox stays small for long enough AND a need
// has been unmet for long enough AND the same skill cycled enough
// times, isWedged() returns true and the reflex injects a `relocate`
// task that supersedes the current need until the bot has displaced
// ≥200 blocks from the wedge centre.
//
// This is intentionally NOT inside any single skill — every skill
// resets its own counters when re-entered, so per-skill stuck checks
// can't break a multi-skill cycle.

const WINDOW_MS = 10 * 60 * 1000;          // 10 minutes
const MIN_BBOX_FOR_WEDGE = 50;             // <50 blocks max-dim → wedge
const MIN_UNMET_NEED_MS = 5 * 60 * 1000;   // need unsatisfied for 5+ min
const MIN_SKILL_CYCLES = 3;                // same need's skill restarted ≥3x

let _samples = [];                          // { t, x, z }
let _activeRelocation = null;               // { startedAt, fromCenter:{x,z}, headingName }
let _needStartedAt = new Map();             // needId → t when first detected
let _lastNeedId = null;

export function _resetForTest() {
	_samples = [];
	_activeRelocation = null;
	_needStartedAt = new Map();
	_lastNeedId = null;
}

/**
 * observe({ x, z, now, activeNeedId, recentSkillIds })
 *
 * Lightweight: called every reflex tick (~1-2s). Updates sliding
 * window and need-duration accounting.
 */
export function observe({ x, z, now = Date.now(), activeNeedId = null, recentSkillIds = [] } = {}) {
	if (typeof x !== "number" || typeof z !== "number") return;
	_samples.push({ t: now, x, z });
	// evict
	const cutoff = now - WINDOW_MS;
	while (_samples.length && _samples[0].t < cutoff) _samples.shift();

	// Track need duration
	if (activeNeedId !== _lastNeedId) {
		_lastNeedId = activeNeedId;
		if (activeNeedId && !_needStartedAt.has(activeNeedId)) {
			_needStartedAt.set(activeNeedId, now);
		}
	}
	if (activeNeedId && !_needStartedAt.has(activeNeedId)) {
		_needStartedAt.set(activeNeedId, now);
	}

	// If a relocation is in progress, check whether we've travelled
	// far enough to clear it.
	if (_activeRelocation && typeof _activeRelocation.fromCenter?.x === "number") {
		const dx = x - _activeRelocation.fromCenter.x;
		const dz = z - _activeRelocation.fromCenter.z;
		if (Math.hypot(dx, dz) >= 200) {
			_activeRelocation = null;
			// Reset all need-duration timers so the post-relocation env
			// gets a fair shot at being labelled satisfied / unsatisfied.
			_needStartedAt = new Map();
		}
	}
}

/**
 * isWedged({ activeNeedId, recentSkillIds, now })
 *   → { wedged: true, bboxDim, needAgeMs, skillCycles, centerX, centerZ } | { wedged: false }
 */
export function isWedged({ activeNeedId, recentSkillIds = [], now = Date.now() } = {}) {
	if (_activeRelocation) return { wedged: false, reason: "relocating" };
	if (_samples.length < 8) return { wedged: false, reason: "insufficient_samples" };

	let xs = Infinity, xb = -Infinity, zs = Infinity, zb = -Infinity, cx = 0, cz = 0;
	for (const s of _samples) {
		if (s.x < xs) xs = s.x;
		if (s.x > xb) xb = s.x;
		if (s.z < zs) zs = s.z;
		if (s.z > zb) zb = s.z;
		cx += s.x; cz += s.z;
	}
	cx /= _samples.length; cz /= _samples.length;
	const bboxDim = Math.max(xb - xs, zb - zs);
	if (bboxDim >= MIN_BBOX_FOR_WEDGE) return { wedged: false, reason: "bbox_ok", bboxDim };

	const needAgeMs = (activeNeedId && _needStartedAt.has(activeNeedId))
		? now - _needStartedAt.get(activeNeedId)
		: 0;
	if (needAgeMs < MIN_UNMET_NEED_MS) return { wedged: false, reason: "need_recent", needAgeMs, bboxDim };

	// Skill cycle count: how many distinct dispatches of the same skill
	// appear in the recent rolling window.
	const skillCycles = countCycles(recentSkillIds);
	if (skillCycles < MIN_SKILL_CYCLES) return { wedged: false, reason: "few_cycles", skillCycles, bboxDim };

	return { wedged: true, bboxDim, needAgeMs, skillCycles, centerX: cx, centerZ: cz };
}

/**
 * markRelocationStarted({ x, z, heading })
 *   The reflex calls this when it dispatches village.relocate. While
 *   a relocation is in flight, isWedged() returns false (relocating)
 *   so we don't fire a SECOND relocation on top.
 */
export function markRelocationStarted({ x, z, heading } = {}) {
	_activeRelocation = {
		startedAt: Date.now(),
		fromCenter: { x, z },
		headingName: heading?.name ?? "?",
	};
}

export function activeRelocation() { return _activeRelocation; }

function countCycles(ids) {
	if (!Array.isArray(ids) || ids.length === 0) return 0;
	// A "cycle" = a transition like A → B → A. Count those.
	let cycles = 0;
	for (let i = 2; i < ids.length; i++) {
		if (ids[i] === ids[i - 2] && ids[i] !== ids[i - 1]) cycles++;
		if (ids[i] === ids[i - 1] && ids[i - 1] === ids[i - 2]) cycles++;
	}
	return cycles;
}

// Test exports
export const __testing = {
	WINDOW_MS, MIN_BBOX_FOR_WEDGE, MIN_UNMET_NEED_MS, MIN_SKILL_CYCLES,
	countCycles,
};
