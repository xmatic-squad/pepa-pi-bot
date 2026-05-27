// Storyline state: which step the bot is currently on.
//
// pickCurrentStep(snapshot) walks STORYLINE from the top and returns
// the first non-completed step. If an emergency condition fires
// (low HP near hostile, lava under foot, etc.) the step is paused and
// callers should defer to manifesto's L0 alive emergency dispatch
// instead of step.suggestSkill.

import { STORYLINE, getStep } from "./storyline.js";
import { isRegistered } from "../skill-registry.js";
import { info } from "../log.js";

const CACHE_TTL_MS = 3_000;

let _cache = null;
let _lastStepId = null;

export function _resetForTest() {
	_cache = null;
	_lastStepId = null;
}

/**
 * pickCurrentStep(snapshot) →
 *   {
 *     step: { id, title, narration_ru },
 *     index: number,                            // 0-based position
 *     suggestion: { skillId, args } | null,
 *     emergency: boolean,                        // true if emergencyPause fires
 *     completedSteps: number                     // how many done so far
 *   } | null
 */
export function pickCurrentStep(snapshot) {
	if (!snapshot?.connected) return null;
	const now = Date.now();
	if (_cache && _cache.snapshot === snapshot && now - _cache.ts < CACHE_TTL_MS) {
		return _cache.result;
	}
	let completedSteps = 0;
	let chosen = null;
	for (let i = 0; i < STORYLINE.length; i++) {
		const step = STORYLINE[i];
		let done;
		try { done = !!step.completed(snapshot); } catch { done = false; }
		if (done) {
			completedSteps += 1;
			continue;
		}
		let emergency = false;
		try { emergency = !!step.emergencyPause?.(snapshot); } catch {}
		let suggestion = null;
		if (!emergency) {
			try { suggestion = step.suggestSkill(snapshot) ?? null; } catch { suggestion = null; }
			if (suggestion?.skillId && !isRegistered(suggestion.skillId)) {
				info("storyline", `step ${step.id}: suggested unknown skill ${suggestion.skillId}; dropping`);
				suggestion = null;
			}
		}
		chosen = {
			step: { id: step.id, title: step.title, narration_ru: step.narration_ru },
			index: i,
			suggestion,
			emergency,
			completedSteps,
		};
		break;
	}
	if (chosen && _lastStepId !== chosen.step.id) {
		info("storyline", `step ${chosen.index + 1}/${STORYLINE.length}: ${chosen.step.id} — ${chosen.step.title} → ${chosen.suggestion?.skillId ?? "(no concrete skill)"}`);
		_lastStepId = chosen.step.id;
	}
	_cache = { snapshot, ts: now, result: chosen };
	return chosen;
}

/**
 * progressSummary(snapshot) → string, e.g.
 *   "step 3/11 'first_tools' — Деревянные орудия → craft.wooden-pickaxe"
 */
export function progressSummary(snapshot) {
	const cur = pickCurrentStep(snapshot);
	if (!cur) return "(no storyline progress — disconnected)";
	const tail = cur.suggestion?.skillId ? ` → ${cur.suggestion.skillId}` : "";
	const emer = cur.emergency ? " [EMERGENCY PAUSE]" : "";
	return `step ${cur.index + 1}/${STORYLINE.length} '${cur.step.id}' — ${cur.step.title}${tail}${emer}`;
}

export { STORYLINE, getStep };
