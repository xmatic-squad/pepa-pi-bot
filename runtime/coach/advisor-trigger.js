// Auto-trigger policy for the fast tactical advisor.
//
// The advisor is too slow for synchronous use inside a reflex tick
// (5-15s via TimeWeb's hosted agent endpoint). The strategy here is
// asynchronous: when conditions warrant tactical advice, fire-and-forget
// an advise() call; when the result eventually arrives, cache it on
// ctx.advisorRecommendation. The next reflex tick reads that cache and
// can substitute the recommended skill before dispatching.
//
// Triggers (any one, AND-ed with the not-recently-asked cooldown):
//
//   1. Wedged > 60s — bot's position hasn't shifted ≥16 blocks in over
//      a minute (already tracked by reflex.js as lastSignificantMoveAt)
//   2. Last 4+ dispatches were the same skill — clear loop signal
//   3. Last awareness preempt was very recent AND followed by same
//      skill being dispatched again — env-shock-blind retry
//
// The recommendation has a TTL (60s). After that it's stale and the
// reflex falls back to manifesto / curriculum. This keeps the system
// reactive — advice ages out, fresh data drives fresh advice.

import { advise, isAvailable as advisorAvailable } from "./fast-advisor.js";
import { isRegistered } from "../skill-registry.js";
import { info, warn } from "../log.js";

const TRIGGER_COOLDOWN_MS = 90_000;
const RECOMMENDATION_TTL_MS = 60_000;
const WEDGED_THRESHOLD_MS = 60_000;
const REPEAT_THRESHOLD = 4;
const PREEMPT_WINDOW_MS = 30_000;

let _lastTriggerAt = 0;
let _inFlight = false;

export function _resetForTest() {
	_lastTriggerAt = 0;
	_inFlight = false;
}

export function getTriggerState() {
	return {
		lastTriggerAt: _lastTriggerAt,
		inFlight: _inFlight,
	};
}

/**
 * tickAdvisor(ctx) → maybe-fires advise() in background.
 *
 * Called from reflex AFTER it has chosen a plannedSkillId but BEFORE
 * dispatching. Does NOT block — the in-flight call resolves later and
 * writes ctx.advisorRecommendation. The caller decides whether to
 * consume a fresh recommendation on this tick or wait for the next.
 */
export function tickAdvisor(ctx, { plannedSkillId } = {}) {
	if (!advisorAvailable()) return { fired: false, reason: "disabled" };
	if (_inFlight) return { fired: false, reason: "in_flight" };

	const now = Date.now();
	if (now - _lastTriggerAt < TRIGGER_COOLDOWN_MS) {
		return { fired: false, reason: "cooldown" };
	}

	// Drop a recommendation that's already aged out.
	if (ctx.advisorRecommendation && now - ctx.advisorRecommendation.at > RECOMMENDATION_TTL_MS) {
		ctx.advisorRecommendation = null;
	}

	const reason = detectTrigger(ctx, now, plannedSkillId);
	if (!reason) return { fired: false, reason: "no_trigger" };

	_lastTriggerAt = now;
	_inFlight = true;
	const snapshot = ctx.snapshot ?? null;
	const recentSkillIds = (ctx.recentSkillIds ?? []).slice(-8);

	info("advisor-trigger", `firing because ${reason} (planned=${plannedSkillId ?? "?"})`);
	// Fire-and-forget. The promise's resolution writes ctx.advisorRecommendation.
	advise({ snapshot, reason, recentSkillIds, lessonsTail: ctx.recentLessons ?? [], force: true })
		.then((result) => {
			_inFlight = false;
			if (result.ok && result.action === "switch_skill" && isRegistered(result.skillId)) {
				ctx.advisorRecommendation = {
					at: Date.now(),
					skillId: result.skillId,
					action: "switch_skill",
					rationale: result.rationale,
					triggerReason: reason,
					latencyMs: result.latencyMs,
					usage: result.usage ?? null,
				};
				info("advisor-trigger", `recommendation cached: ${result.skillId} (${result.latencyMs}ms, in=${result.usage?.in ?? "?"}t/out=${result.usage?.out ?? "?"}t)`);
			} else if (result.ok && (result.action === "wait" || result.action === "continue")) {
				ctx.advisorRecommendation = {
					at: Date.now(),
					action: result.action,
					rationale: result.rationale,
					triggerReason: reason,
					latencyMs: result.latencyMs,
					usage: result.usage ?? null,
				};
				info("advisor-trigger", `recommendation: ${result.action} (${result.latencyMs}ms)`);
			} else if (!result.ok) {
				warn("advisor-trigger", `advise failed: ${result.code} (${result.detail})`);
			}
		})
		.catch((e) => {
			_inFlight = false;
			warn("advisor-trigger", `advise threw: ${e?.message ?? e}`);
		});

	return { fired: true, reason };
}

function detectTrigger(ctx, now, plannedSkillId) {
	// 1. Wedged > threshold
	if (ctx.lastSignificantMoveAt && (now - ctx.lastSignificantMoveAt) > WEDGED_THRESHOLD_MS) {
		return `wedged_${Math.round((now - ctx.lastSignificantMoveAt) / 1000)}s`;
	}
	// 2. Repeat-skill loop
	const recent = ctx.recentSkillIds ?? [];
	if (recent.length >= REPEAT_THRESHOLD) {
		const tail = recent.slice(-REPEAT_THRESHOLD);
		const allSame = tail.every((id) => id === tail[0]);
		if (allSame && plannedSkillId === tail[0]) {
			return `repeat_${REPEAT_THRESHOLD}_${tail[0]}`;
		}
	}
	// 3. Recent preempt followed by same skill again
	if (ctx.lastPreempt && now - ctx.lastPreempt.at < PREEMPT_WINDOW_MS) {
		const lastDispatched = recent[recent.length - 1];
		if (lastDispatched && lastDispatched === plannedSkillId) {
			return `preempt_retry_${ctx.lastPreempt.reason}`;
		}
	}
	return null;
}

/**
 * consumeFreshRecommendation(ctx) → { skillId, action, rationale } | null
 *
 * Returns a recommendation if one is currently cached and fresh, and
 * clears it so subsequent ticks don't re-apply the same advice.
 */
export function consumeFreshRecommendation(ctx) {
	const rec = ctx.advisorRecommendation;
	if (!rec) return null;
	if (Date.now() - rec.at > RECOMMENDATION_TTL_MS) {
		ctx.advisorRecommendation = null;
		return null;
	}
	if (rec.action !== "switch_skill" || !rec.skillId) {
		// 'continue' / 'wait' don't replace dispatch; surface for telemetry only
		return null;
	}
	ctx.advisorRecommendation = null;
	return rec;
}

// Test exports
export const __testing = {
	TRIGGER_COOLDOWN_MS, RECOMMENDATION_TTL_MS, WEDGED_THRESHOLD_MS,
	REPEAT_THRESHOLD, PREEMPT_WINDOW_MS, detectTrigger,
};
