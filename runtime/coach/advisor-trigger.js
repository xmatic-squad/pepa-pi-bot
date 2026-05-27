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
import { insertRecommendation } from "../knowledge/index.js";
import { info, warn } from "../log.js";

const TRIGGER_COOLDOWN_MS = 90_000;
const RECOMMENDATION_TTL_MS = 60_000;
const WEDGED_THRESHOLD_MS = 60_000;
const REPEAT_THRESHOLD = 4;
const PREEMPT_WINDOW_MS = 30_000;
// Emergency triggers — bypass cooldown because waiting another 90s
// when the bot is about to die is not useful.
const EMERGENCY_HP = 6;
const EMERGENCY_HOSTILE_DIST = 8;
const EMERGENCY_COOLDOWN_MS = 20_000;
// LLM outage backoff — if 3 consecutive advise() calls return
// http_400 / network_error, suppress further calls for 10 minutes.
const PROVIDER_OUTAGE_FAILS = 3;
const PROVIDER_OUTAGE_BACKOFF_MS = 10 * 60 * 1000;

let _lastTriggerAt = 0;
let _inFlight = false;
let _consecutiveFails = 0;
let _providerOutageUntil = 0;

export function _resetForTest() {
	_lastTriggerAt = 0;
	_inFlight = false;
	_consecutiveFails = 0;
	_providerOutageUntil = 0;
}

function isProviderError(code) {
	return code === "network_error"
		|| code === "timeout"
		|| (typeof code === "string" && code.startsWith("http_"));
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
	if (_providerOutageUntil > now) {
		return { fired: false, reason: "provider_outage", retryAt: _providerOutageUntil };
	}

	// Drop a recommendation that's already aged out.
	if (ctx.advisorRecommendation && now - ctx.advisorRecommendation.at > RECOMMENDATION_TTL_MS) {
		ctx.advisorRecommendation = null;
	}

	const reason = detectTrigger(ctx, now, plannedSkillId);
	if (!reason) return { fired: false, reason: "no_trigger" };

	// Emergency triggers use a much shorter cooldown — waiting 90s with
	// HP=4 and a creeper at 3 blocks is exactly when we MUST hit the LLM.
	const isEmergency = reason.startsWith("emergency_");
	const cooldownMs = isEmergency ? EMERGENCY_COOLDOWN_MS : TRIGGER_COOLDOWN_MS;
	if (now - _lastTriggerAt < cooldownMs) {
		return { fired: false, reason: "cooldown" };
	}

	_lastTriggerAt = now;
	_inFlight = true;
	const snapshot = ctx.snapshot ?? null;
	const recentSkillIds = (ctx.recentSkillIds ?? []).slice(-8);
	const activeNeed = ctx.activeNeed ?? null;
	const storyStep = ctx.storyStep ?? null;

	info("advisor-trigger", `firing because ${reason} (planned=${plannedSkillId ?? "?"}, need=${activeNeed?.need?.id ?? "?"}, step=${storyStep?.step?.id ?? "?"})`);
	// Fire-and-forget. The promise's resolution writes ctx.advisorRecommendation.
	advise({ snapshot, reason, recentSkillIds, lessonsTail: ctx.recentLessons ?? [], activeNeed, storyStep, force: true })
		.then((result) => {
			_inFlight = false;
			const needLabel = activeNeed
				? `L${activeNeed.need.level} ${activeNeed.need.id}`
				: null;
			if (result.ok && result.action === "switch_skill" && isRegistered(result.skillId)) {
				const recId = insertRecommendation({
					triggerReason: reason,
					plannedSkill: plannedSkillId ?? null,
					recommendedSkill: result.skillId,
					action: "switch_skill",
					rationale: result.rationale,
					activeNeed: needLabel,
					tokensIn: result.usage?.in,
					tokensOut: result.usage?.out,
					latencyMs: result.latencyMs,
				});
				ctx.advisorRecommendation = {
					id: recId,
					at: Date.now(),
					skillId: result.skillId,
					action: "switch_skill",
					rationale: result.rationale,
					triggerReason: reason,
					latencyMs: result.latencyMs,
					usage: result.usage ?? null,
				};
				info("advisor-trigger", `recommendation cached: ${result.skillId} (${result.latencyMs}ms, in=${result.usage?.in ?? "?"}t/out=${result.usage?.out ?? "?"}t, db=${recId ?? "-"})`);
			} else if (result.ok && (result.action === "wait" || result.action === "continue")) {
				const recId = insertRecommendation({
					triggerReason: reason,
					plannedSkill: plannedSkillId ?? null,
					recommendedSkill: null,
					action: result.action,
					rationale: result.rationale,
					activeNeed: needLabel,
					tokensIn: result.usage?.in,
					tokensOut: result.usage?.out,
					latencyMs: result.latencyMs,
				});
				ctx.advisorRecommendation = {
					id: recId,
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
				if (isProviderError(result.code)) {
					_consecutiveFails += 1;
					if (_consecutiveFails >= PROVIDER_OUTAGE_FAILS) {
						_providerOutageUntil = Date.now() + PROVIDER_OUTAGE_BACKOFF_MS;
						warn("advisor-trigger", `LLM provider outage (${_consecutiveFails} fails in a row); backing off ${Math.round(PROVIDER_OUTAGE_BACKOFF_MS / 60000)}min`);
					}
				}
			} else {
				_consecutiveFails = 0;
			}
		})
		.catch((e) => {
			_inFlight = false;
			warn("advisor-trigger", `advise threw: ${e?.message ?? e}`);
		});

	return { fired: true, reason };
}

function detectTrigger(ctx, now, plannedSkillId) {
	const snap = ctx.snapshot ?? {};

	// 0. EMERGENCY: low HP + hostile near — call BEFORE the bot dies.
	// Checked first so reason string starts with "emergency_" → bypasses
	// the long trigger cooldown via the caller's isEmergency check.
	const hp = snap.health ?? 20;
	const hostile = snap.closestHostile;
	if (hp <= EMERGENCY_HP && hostile && (hostile.distance ?? Infinity) <= EMERGENCY_HOSTILE_DIST) {
		return `emergency_hp${Math.round(hp)}_${hostile.name ?? "hostile"}@${Math.round(hostile.distance)}`;
	}
	// 0b. EMERGENCY: drowning / lava / lethal fluid
	if (snap.hazards?.footBlock === "lava") {
		return "emergency_lava";
	}

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
