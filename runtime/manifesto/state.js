// Manifesto state: cached "active need" for the current tick.
//
// Each reflex pass calls pickActiveNeed(snapshot) — it walks the
// needs ladder from level 0 upward and returns the FIRST need whose
// detect() is false AND whose pursue() returns a non-null skill id.
// Needs whose pursue() returns null (e.g. armour while we lack craft
// skills) are recorded as "blocked at this level" but the ladder
// continues — that way the bot still makes progress on lower-priority
// concerns instead of stalling.

import { NEEDS, getNeed } from "./needs.js";
import { isRegistered } from "../skill-registry.js";
import { info } from "../log.js";

const CACHE_TTL_MS = 3_000;

let _cache = null;
let _lastNeedId = null;

export function _resetForTest() {
	_cache = null;
	_lastNeedId = null;
}

/**
 * pickActiveNeed(snapshot) →
 *   {
 *     need: { id, level, title },
 *     skillId: string,                 // dispatch this skill
 *     args: object | undefined,
 *     blockedNeeds: Array<{id, level}> // needs above this one whose pursue=null
 *   } | null
 *
 * Returns null only when *every* need is satisfied (i.e. village_full
 * is detected, which is never true in practice — global goal). In
 * that case callers should fall back to the curriculum.
 */
export function pickActiveNeed(snapshot) {
	if (!snapshot?.connected) return null;
	const now = Date.now();
	if (_cache && _cache.snapshot === snapshot && now - _cache.ts < CACHE_TTL_MS) {
		return _cache.result;
	}
	const blocked = [];
	let chosen = null;
	for (const need of NEEDS) {
		let satisfied;
		try {
			satisfied = !!need.detect(snapshot);
		} catch (e) {
			info("manifesto", `need ${need.id}.detect threw: ${e?.message ?? e}`);
			satisfied = true;
		}
		if (satisfied) continue;
		let plan;
		try {
			plan = need.pursue(snapshot);
		} catch (e) {
			info("manifesto", `need ${need.id}.pursue threw: ${e?.message ?? e}`);
			plan = null;
		}
		if (!plan || !plan.skillId) {
			blocked.push({ id: need.id, level: need.level });
			continue;
		}
		if (!isRegistered(plan.skillId)) {
			info("manifesto", `need ${need.id}: pursue suggested unknown skill ${plan.skillId}; skipping`);
			blocked.push({ id: need.id, level: need.level });
			continue;
		}
		chosen = { need: { id: need.id, level: need.level, title: need.title }, skillId: plan.skillId, args: plan.args, blockedNeeds: blocked };
		break;
	}
	if (chosen) {
		if (_lastNeedId !== chosen.need.id) {
			info("manifesto", `active need: L${chosen.need.level} ${chosen.need.id} → ${chosen.skillId}`);
			_lastNeedId = chosen.need.id;
		}
	}
	_cache = { snapshot, ts: now, result: chosen };
	return chosen;
}

export function describeActiveNeed(snapshot) {
	const a = pickActiveNeed(snapshot);
	if (!a) return null;
	return `L${a.need.level} ${a.need.id} → ${a.skillId}`;
}

// Re-export ladder for callers that want to enumerate.
export { NEEDS, getNeed };
