// coach/advice.js — turn knowledge.lessons into actionable dispatch overrides.
//
// The reflex chain calls consult() right before it would dispatch a
// planned skill. If a high-confidence lesson in the knowledge DB says
// "avoid that skill in this situation", we either swap in the lesson's
// preferred alternative or back off (which the curriculum reflex
// translates into wander / cooldown).
//
// This is the closing of the learning loop: post-mortem → lesson →
// recall → behavioural change. Without this, the DB is just a log.

import { isAvailable as knowledgeAvailable, topAdvice, markApplied } from "../knowledge/index.js";
import { info } from "../log.js";

// Skills we will not blindly swap into — they require their own
// preconditions (e.g. survive.flee needs a known threat direction).
// The dispatcher will still run runSkill on them, which performs the
// real precondition check.
const SAFE_OVERRIDES = new Set([
	"survive.flee",
	"survive.sleep",
	"survive.eat",
	"recovery.tunnel-out",
	"explore.far",
	"explore.wander",
	"village.build-shelter",
]);

// Pi-coach occasionally suggests prefer_skill values that are mode names
// (from runtime/modes.js) rather than registered skill ids. We translate
// them to the closest equivalent skill before the SAFE_OVERRIDES check.
// Unknown values are returned as-is and will fall through to 'avoid'.
const MODE_TO_SKILL = Object.freeze({
	self_preservation: "survive.flee",
	night_shelter: "survive.sleep",
	hunger: "survive.eat",
	shelter: "village.build-shelter",
	flee: "survive.flee",
	sleep: "survive.sleep",
	eat: "survive.eat",
	tunnel_out: "recovery.tunnel-out",
	"tunnel-out": "recovery.tunnel-out",
	explore: "explore.far",
	wander: "explore.far",
});

function normalisePreferSkill(raw) {
	if (!raw || typeof raw !== "string") return raw;
	if (SAFE_OVERRIDES.has(raw)) return raw;
	const lower = raw.toLowerCase().trim();
	if (MODE_TO_SKILL[lower]) return MODE_TO_SKILL[lower];
	// Pi sometimes writes "survive_flee" or "survive flee"; normalise.
	const dot = lower.replace(/[_\s]+/g, ".");
	if (SAFE_OVERRIDES.has(dot)) return dot;
	if (MODE_TO_SKILL[dot]) return MODE_TO_SKILL[dot];
	return raw;
}

/**
 * consult({ plannedSkillId, snapshot })
 *   → { action: 'override'|'avoid'|'proceed', overrideSkillId?, lessonId?, lesson? }
 *
 * 'override'  — dispatch overrideSkillId instead of plannedSkillId
 * 'avoid'     — don't dispatch plannedSkillId; caller falls back to wander/idle
 * 'proceed'   — no high-confidence lesson applies; dispatch as planned
 */
export function consult({ plannedSkillId, snapshot } = {}) {
	if (!knowledgeAvailable()) return PROCEED;
	if (!plannedSkillId) return PROCEED;
	const hostile = snapshot?.closestHostile?.name ?? snapshot?.threats?.[0]?.name ?? null;
	const situation = snapshot?.situationHash ?? null;
	const advice = topAdvice({
		skill: plannedSkillId,
		hostile,
		situation,
	});
	if (!advice.lessonId) return PROCEED;

	// avoid_skill matches?
	if (advice.avoid && advice.avoid === plannedSkillId) {
		const normalisedPrefer = normalisePreferSkill(advice.prefer);
		if (normalisedPrefer && SAFE_OVERRIDES.has(normalisedPrefer)) {
			if (normalisedPrefer !== advice.prefer) {
				info("coach", `advice: normalised prefer "${advice.prefer}" → "${normalisedPrefer}"`);
			}
			info("coach", `advice: override ${plannedSkillId} → ${normalisedPrefer} (lesson #${advice.lessonId})`);
			return {
				action: "override",
				overrideSkillId: normalisedPrefer,
				lessonId: advice.lessonId,
				lesson: advice.lesson,
			};
		}
		info("coach", `advice: avoid ${plannedSkillId} (lesson #${advice.lessonId})`);
		return { action: "avoid", lessonId: advice.lessonId, lesson: advice.lesson };
	}
	return PROCEED;
}

/**
 * After the dispatcher runs the (possibly overridden) skill, call this
 * with the lesson id and whether the outcome was good. Increments the
 * lesson's applied/succeeded counters and nudges its confidence.
 */
export function reportOutcome({ lessonId, succeeded }) {
	if (!lessonId) return;
	markApplied(lessonId, { succeeded: !!succeeded });
}

const PROCEED = Object.freeze({ action: "proceed", lessonId: null, lesson: null });

// Test exports
export const __testing = { SAFE_OVERRIDES, MODE_TO_SKILL, normalisePreferSkill };
