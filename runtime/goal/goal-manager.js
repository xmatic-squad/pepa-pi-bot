// GoalManager (L3) — the single progression authority.
//
// Walks the Settlement Contract, evaluates each milestone's invariants against
// the world, and selects which milestone to pursue now. Selection is a utility
// argmax over the UNMET milestones:
//
//     score(m) = -index(m) + urgency(m, world)
//
// With no urgency this is just "lowest unmet milestone wins" (strict ordered
// progression). urgency lets a survival-critical milestone (food when starving)
// preempt a lower-indexed one — the DEPS-style "consider how easy/urgent a
// sub-goal is" idea, expressed as a hand-tuned utility (research §C, DEPS).
//
// The GoalManager does NOT dispatch and never calls the LLM. It returns a
// suggestion the scheduler consumes; the survival/emergency layer (modes,
// manifesto L0) still preempts above it.

import { SETTLEMENT_CONTRACT } from "./contract.js";
import { checkInvariants, worldFromSnapshot } from "./invariants.js";
import { prerequisitesMet } from "./skill-graph.js";

export function createGoalManager({ contract = SETTLEMENT_CONTRACT } = {}) {
	// Evaluate every milestone; returns the per-milestone invariant status plus
	// the selected current milestone and its suggested skill.
	function evaluate(world) {
		const evaluated = contract.map((m, index) => {
			const check = checkInvariants(m, world);
			return {
				index,
				id: m.id,
				title: m.title,
				met: check.met,
				unmet: check.unmet,
				evidence: check.evidence,
				urgency: typeof m.urgency === "function" ? (m.urgency(world) || 0) : 0,
				_m: m,
			};
		});

		const completed = evaluated.filter((e) => e.met).length;
		const total = evaluated.length;
		const unmet = evaluated.filter((e) => !e.met);

		if (unmet.length === 0) {
			return { done: true, completed, total, milestone: null, suggestedSkill: null, ranked: [], evaluated };
		}

		// Utility argmax. Tie-break by lower index (more foundational first).
		const ranked = unmet
			.map((e) => ({ ...e, score: -e.index + e.urgency }))
			.sort((a, b) => b.score - a.score || a.index - b.index);

		const current = ranked[0];
		let suggestedSkill = null;
		try {
			suggestedSkill = current._m.suggest(world) ?? null;
		} catch {
			suggestedSkill = null;
		}

		// Annotate the suggestion with skill-graph prerequisite status (Plan4MC).
		// Observability + a guard surface: if prereqs are unmet the curriculum
		// chain should already be steering toward them, but we expose the gap.
		if (suggestedSkill?.skillId) {
			const pre = prerequisitesMet(suggestedSkill.skillId, world);
			if (!pre.ok) suggestedSkill = { ...suggestedSkill, blockedBy: pre.missing };
		}

		const reason = current.urgency > 0 && current.index > unmet[0].index
			? `urgent:${current.id}(${current.urgency}) preempts ${unmet[0].id}`
			: `lowest unmet: ${current.id}`;

		return {
			done: false,
			completed,
			total,
			milestone: { id: current.id, title: current.title, unmet: current.unmet },
			suggestedSkill,
			reason,
			ranked: ranked.map((r) => ({ id: r.id, score: r.score, urgency: r.urgency })),
			evaluated,
		};
	}

	// Convenience: build the world from a runtime snapshot (+optional ledger)
	// and evaluate. This is what the scheduler calls each tick.
	function next(snapshot, extra = {}) {
		const world = worldFromSnapshot(snapshot, extra);
		return evaluate(world);
	}

	return { evaluate, next };
}
