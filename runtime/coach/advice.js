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
		if (advice.prefer && SAFE_OVERRIDES.has(advice.prefer)) {
			info("coach", `advice: override ${plannedSkillId} → ${advice.prefer} (lesson #${advice.lessonId})`);
			return {
				action: "override",
				overrideSkillId: advice.prefer,
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
export const __testing = { SAFE_OVERRIDES };
