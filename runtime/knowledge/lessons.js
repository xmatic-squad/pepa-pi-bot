// Lesson recall, recording, and outcome tracking.
//
// A "lesson" is a generalised rule the bot has learned: "don't attack
// creepers with fists", "gather.logs timeouts here, move on", "fight
// skeletons under cover only". Recall is best-effort: returns the top-K
// lessons matching the situation, sorted by confidence × recency.
//
// The dispatch path uses recall() to ALTER its planned action — see
// runtime/coach/advice.js. Lessons are immutable rows once written; the
// applied / succeeded counters and confidence are updated separately.

import { isAvailable, getStore } from "./store.js";
import { warn } from "../log.js";

const RECALL_DEFAULT_LIMIT = 8;
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // a week — older lessons score lower

/**
 * recall({ skill?, hostile?, situation?, category?, limit? })
 *   → Lesson[]
 *
 * Best-match lessons in confidence order with light recency boost.
 * Any missing filter widens the search; passing none returns the most
 * confident recent lessons.
 */
export function recall({ skill, hostile, situation, category, limit = RECALL_DEFAULT_LIMIT } = {}) {
	if (!isAvailable()) return [];
	const db = getStore();
	const conds = [];
	const params = {};
	if (skill)     { conds.push("(trigger_skill IS NULL OR trigger_skill = @skill)"); params.skill = skill; }
	if (hostile)   { conds.push("(trigger_hostile IS NULL OR trigger_hostile = @hostile)"); params.hostile = hostile; }
	if (situation) { conds.push("(trigger_situation IS NULL OR trigger_situation = @situation)"); params.situation = situation; }
	if (category)  { conds.push("category = @category"); params.category = category; }
	const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
	try {
		const rows = db.prepare(`
			SELECT id, text, category, trigger_skill, trigger_hostile, trigger_situation,
			       avoid_skill, prefer_skill, confidence, applied_count, succeeded_count,
			       source, source_ref, ts
			FROM lessons
			${where}
			ORDER BY confidence DESC, ts DESC
			LIMIT @limit
		`).all({ ...params, limit });
		return rows.map(scoreLesson).sort((a, b) => b._score - a._score);
	} catch (e) {
		warn("knowledge", `recall failed: ${e?.message ?? e}`);
		return [];
	}
}

function scoreLesson(row) {
	const ageMs = Math.max(0, Date.now() - (row.ts ?? 0));
	const recency = ageMs < RECENCY_WINDOW_MS
		? 1 - ageMs / RECENCY_WINDOW_MS
		: 0;
	const applied = row.applied_count ?? 0;
	const succeeded = row.succeeded_count ?? 0;
	// Reward lessons that have been applied successfully.
	const validation = applied > 0 ? succeeded / applied : 0;
	row._score = row.confidence * 0.6 + recency * 0.2 + validation * 0.2;
	return row;
}

/**
 * record({ text, category, ... })
 *   → { ok, id }
 *
 * Insert a new lesson. Does NOT dedupe; callers should check recall()
 * first if dedupe matters. (For Pi-extracted lessons, near-duplicates
 * are fine — variety helps recall.)
 */
export function record({
	text,
	category = "survival",
	triggerSkill = null,
	triggerHostile = null,
	triggerSituation = null,
	avoidSkill = null,
	preferSkill = null,
	confidence = 0.5,
	source = "pi-coach",
	sourceRef = null,
} = {}) {
	if (!isAvailable()) return { ok: false, reason: "store unavailable" };
	if (!text || typeof text !== "string") return { ok: false, reason: "text required" };
	try {
		const stmt = getStore().prepare(`
			INSERT INTO lessons (ts, text, category, trigger_skill, trigger_hostile, trigger_situation,
			                     avoid_skill, prefer_skill, confidence, applied_count, succeeded_count,
			                     source, source_ref)
			VALUES (@ts, @text, @category, @triggerSkill, @triggerHostile, @triggerSituation,
			        @avoidSkill, @preferSkill, @confidence, 0, 0, @source, @sourceRef)
		`);
		const info = stmt.run({
			ts: Date.now(),
			text,
			category,
			triggerSkill,
			triggerHostile,
			triggerSituation,
			avoidSkill,
			preferSkill,
			confidence: Math.max(0, Math.min(1, confidence)),
			source,
			sourceRef,
		});
		return { ok: true, id: info.lastInsertRowid };
	} catch (e) {
		warn("knowledge", `record failed: ${e?.message ?? e}`);
		return { ok: false, reason: e?.message ?? String(e) };
	}
}

/**
 * markApplied(id, { succeeded })
 *   Bumps applied_count, and if succeeded=true, succeeded_count too.
 *   Adjusts confidence: success increases it slightly, failure decreases.
 */
export function markApplied(id, { succeeded = false } = {}) {
	if (!isAvailable()) return false;
	try {
		const stmt = getStore().prepare(`
			UPDATE lessons SET
				applied_count   = applied_count + 1,
				succeeded_count = succeeded_count + @suc,
				confidence      = MIN(1.0, MAX(0.05, confidence + @delta))
			WHERE id = @id
		`);
		stmt.run({
			id,
			suc: succeeded ? 1 : 0,
			delta: succeeded ? 0.05 : -0.03,
		});
		return true;
	} catch (e) {
		warn("knowledge", `markApplied failed: ${e?.message ?? e}`);
		return false;
	}
}

/**
 * topAdvice({ skill, hostile, situation, hp, food, hasWeapon })
 *   → { avoid: string | null, prefer: string | null, lessonId: number | null, lesson: string | null }
 *
 * Reduce recalled lessons to one actionable directive. The dispatch
 * layer reads this and adjusts its plan; if no high-confidence lesson
 * applies, returns empty advice and the caller proceeds as normal.
 */
export function topAdvice(ctx = {}) {
	const lessons = recall({
		skill: ctx.skill,
		hostile: ctx.hostile,
		situation: ctx.situation,
		limit: 6,
	});
	for (const l of lessons) {
		if (l.confidence < 0.6) break;
		if (l.avoid_skill || l.prefer_skill) {
			return {
				avoid: l.avoid_skill ?? null,
				prefer: l.prefer_skill ?? null,
				lessonId: l.id,
				lesson: l.text,
			};
		}
	}
	return { avoid: null, prefer: null, lessonId: null, lesson: null };
}

/** Test-only helpers. Not exported through index.js. */
export function __wipeForTests() {
	if (!isAvailable()) return;
	try {
		getStore().exec("DELETE FROM lessons");
	} catch {}
}
