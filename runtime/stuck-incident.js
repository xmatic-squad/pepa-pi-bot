// Stuck-incident detector. Today's failure-tracker in bot.js fires
// proposals on repeated *exception-class* failures (TypeError, timeout).
// This module fires on "no-progress" stagnation — the bot is healthy and
// the reflex loop hasn't crashed, but a single reason code (e.g.
// no_food_source, planner_empty) keeps coming back tick after tick.
//
// When the same reason persists past STUCK_THRESHOLD_MS we build a
// proposal body summarising the situation, including:
//   - the no-progress reason
//   - the active milestone + suggested skill
//   - a slim snapshot
//   - the last skill result
//   - per-skill success/failure metrics (if available)
//   - the allowed edit scope ("runtime/skills/<skill>.js" plus tests)
//
// The caller (bot.js) is responsible for actually writing the proposal —
// this module just produces the body string when the threshold trips.

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;

export function createStuckIncidentDetector({ thresholdMs = STUCK_THRESHOLD_MS, cooldownMs = COOLDOWN_MS } = {}) {
	let currentReason = null;
	let firstSeenAt = 0;
	let lastFiredAt = 0;

	function reset() {
		currentReason = null;
		firstSeenAt = 0;
	}

	// Returns { fire: true, body, kind, editScope } when an incident should
	// be filed this tick; null otherwise.
	function check({ snapshot, lastResult, metrics, now = Date.now() }) {
		const reason = snapshot?.noProgressReason ?? null;
		if (!reason) {
			reset();
			return null;
		}
		if (reason !== currentReason) {
			currentReason = reason;
			firstSeenAt = now;
			return null;
		}
		if (now - firstSeenAt < thresholdMs) return null;
		if (lastFiredAt > 0 && now - lastFiredAt < cooldownMs) return null;
		lastFiredAt = now;

		const milestone = snapshot?.curriculum?.milestone;
		const suggested = snapshot?.curriculum?.plan?.skillId;
		const slim = {
			runtimeState: snapshot.runtimeState,
			noProgressReason: reason,
			milestone: milestone?.title ?? null,
			suggestedSkill: suggested ?? null,
			position: snapshot.position,
			health: snapshot.health,
			food: snapshot.food,
			isDay: snapshot.isDay,
			inventoryCounts: Object.keys(snapshot.inventory ?? {}).length,
			closestHostile: snapshot.closestHostile,
		};

		const editScope = suggested
			? [`runtime/skills/${suggested.replace(/\./g, "-")}.js`, `runtime/skills/`]
			: ["runtime/skills/", "runtime/"];

		const metricsLine = metrics && Object.keys(metrics).length
			? Object.entries(metrics)
				.map(([id, m]) => `${id}: ok=${m.ok} fail=${m.fail}`)
				.join(", ")
			: "(none)";

		const body = [
			`# Stuck on \`${reason}\``,
			"",
			`The runtime has reported the same no-progress reason for >${Math.round(thresholdMs / 60000)} min without a productive action.`,
			"",
			"## Current state",
			"",
			"```json",
			JSON.stringify(slim, null, 2),
			"```",
			"",
			"## Last action result",
			"",
			lastResult
				? `\`${lastResult.label}\` → ${lastResult.code ?? (lastResult.ok ? "ok" : "fail")}${lastResult.detail ? ` (${JSON.stringify(lastResult.detail).slice(0, 200)})` : ""}`
				: "_(none recorded)_",
			"",
			"## Skill metrics so far",
			"",
			metricsLine,
			"",
			"## Suggested fix",
			"",
			suggested
				? `Improve \`${suggested}\` so the bot can clear the \`${reason}\` blocker. Touch only the listed files. Add or update tests under \`runtime/skills/\`.`
				: `The curriculum has no suggested skill for this state. Either teach the curriculum a new milestone OR add a recovery skill that turns this reason code into a productive action.`,
			"",
			"## Edit scope (auto-patch must obey this)",
			"",
			editScope.map((p) => `- ${p}`).join("\n"),
			"",
			"## Forbidden",
			"",
			"- Don't touch `.env`, `state/`, `extensions/`, `tui/` unless the scope above includes them.",
			"- Don't add new npm dependencies.",
			"- Don't change git history (no `--amend`, no `git reset --hard`).",
			"",
		].join("\n");

		return {
			fire: true,
			kind: `stuck-${reason}`,
			summary: `stuck on ${reason}${milestone ? ` (milestone: ${milestone.title})` : ""}`,
			body,
			editScope,
		};
	}

	return { check, reset };
}
