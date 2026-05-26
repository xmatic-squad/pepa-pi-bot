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

	// Additional trigger path: when the bot has produced N "non-productive
	// completions" in a row (same skill returning mode:escape-pit /
	// wedged-jump / blind walk, no inventory or position change), fire a
	// stuck incident immediately — these are exactly the cases where Pi
	// should write a NEW skill, not patch an existing one.
	let consecutiveWedged = 0;
	const WEDGED_FIRE_AT = 3;
	let lastWedgedFireAt = 0;
	const WEDGED_COOLDOWN_MS = 10 * 60_000;

	function reset() {
		currentReason = null;
		firstSeenAt = 0;
	}

	// Caller pings this every time an action completes; we look at the
	// mode/detail to decide if it counts as "wedged" (bot didn't really
	// accomplish anything in-world).
	function noteResult(res) {
		const mode = res?.detail?.mode ?? res?.worldDelta?.mode;
		const isWedgedShape = mode === "escape-pit" || mode === "wedged-jump" || mode === "blind" || mode === "wedged-jump";
		if (isWedgedShape && res?.ok) {
			consecutiveWedged++;
		} else if (res?.ok) {
			consecutiveWedged = 0;
		}
	}

	function wedgedShouldFire(now = Date.now()) {
		if (consecutiveWedged < WEDGED_FIRE_AT) return false;
		if (now - lastWedgedFireAt < WEDGED_COOLDOWN_MS) return false;
		lastWedgedFireAt = now;
		consecutiveWedged = 0;
		return true;
	}

	// Returns { fire: true, body, kind, editScope } when an incident should
	// be filed this tick; null otherwise.
	function check({ snapshot, lastResult, metrics, journalSummary, scenarioTail, now = Date.now() }) {
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

		const journalLine = journalSummary
			? `byKind=${JSON.stringify(journalSummary.byKind ?? {})} buckets=${journalSummary.totalBuckets ?? 0}`
			: "(no journal)";

		const scenarioLines = Array.isArray(scenarioTail) && scenarioTail.length
			? scenarioTail.map((e) =>
				`- \`${e.skillId}\` ${e.ok ? "OK" : "FAIL"} code=${e.code ?? "?"} ${e.detail ? `(${e.detail.slice?.(0, 120) ?? ""})` : ""} situ=${e.situationHashShort ?? "?"}`,
			).join("\n")
			: "_(no scenario memory recorded yet)_";

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
			"## Skill metrics so far (this process lifetime)",
			"",
			metricsLine,
			"",
			"## World journal (what we have discovered so far)",
			"",
			journalLine,
			"",
			"## Recent scenario memory (last attempts, what worked / failed in similar situations)",
			"",
			scenarioLines,
			"",
			"## Suggested fix",
			"",
			suggested
				? `Improve \`${suggested}\` so the bot can clear the \`${reason}\` blocker, OR teach a NEW skill that handles this kind of situation if no single edit fixes it. Touch only the listed files (the test files under runtime/**/*.test.js are auto-allowed). Use the scenario-memory entries above to avoid re-introducing patterns that already failed.`
				: `The curriculum has no suggested skill for this state. Either teach the curriculum a new milestone OR add a recovery skill that turns this reason code into a productive action. The scenario memory above shows what's been tried.`,
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

	function checkWedged({ snapshot, lastResult, metrics, journalSummary, scenarioTail, now = Date.now() }) {
		if (!wedgedShouldFire(now)) return null;
		const slim = {
			runtimeState: snapshot?.runtimeState,
			noProgressReason: snapshot?.noProgressReason,
			position: snapshot?.position,
			health: snapshot?.health,
			food: snapshot?.food,
			isDay: snapshot?.isDay,
			inventoryCounts: Object.keys(snapshot?.inventory ?? {}).length,
		};
		const metricsLine = metrics && Object.keys(metrics).length
			? Object.entries(metrics).map(([id, m]) => `${id}: ok=${m.ok} fail=${m.fail}`).join(", ")
			: "(none)";
		const journalLine = journalSummary
			? `byKind=${JSON.stringify(journalSummary.byKind ?? {})} buckets=${journalSummary.totalBuckets ?? 0}`
			: "(none)";
		const scenarioLines = Array.isArray(scenarioTail) && scenarioTail.length
			? scenarioTail.map((e) =>
				`- \`${e.skillId}\` ${e.ok ? "OK" : "FAIL"} code=${e.code ?? "?"} ${e.detail ? `(${e.detail.slice?.(0, 120) ?? ""})` : ""} situ=${e.situationHashShort ?? "?"}`,
			).join("\n")
			: "_(no scenario memory)_";

		const body = [
			`# Wedged — escape-pit cannot extract the bot`,
			"",
			`The bot has produced ${WEDGED_FIRE_AT}+ "wedged-jump / escape-pit / blind" completions in a row.`,
			"In-world it stands still; the existing escape primitives are not enough.",
			"",
			"## Current state",
			"```json",
			JSON.stringify(slim, null, 2),
			"```",
			"",
			"## Last action result",
			lastResult
				? `\`${lastResult.label}\` → ${lastResult.code ?? (lastResult.ok ? "ok" : "fail")} ${lastResult.detail ? `(${JSON.stringify(lastResult.detail).slice(0, 200)})` : ""}`
				: "_(none)_",
			"",
			"## Skill metrics",
			metricsLine,
			"",
			"## World journal byKind",
			journalLine,
			"",
			"## Recent scenario memory (last attempts)",
			scenarioLines,
			"",
			"## Suggested fix",
			"",
			"Either improve `escapePit()` in `runtime/actions.js` (e.g. dig forward + down + side, not only up) OR add a NEW skill `recovery.tunnel-out` that breaks the bot out of a 1×1 hole by digging a 3-block tunnel in the most-free cardinal. Add tests under `runtime/skills/`.",
			"",
			"## Edit scope",
			"- runtime/actions.js",
			"- runtime/skills/",
			"- runtime/reflex.js",
			"",
			"## Forbidden",
			"- Don't touch `.env`, `state/`, `extensions/`, `tui/`, `package.json`.",
			"- Don't add new npm dependencies.",
		].join("\n");

		return {
			fire: true,
			kind: "wedged-cant-escape",
			summary: "bot wedged in place; escape-pit ran 3× without freeing it",
			body,
			editScope: ["runtime/actions.js", "runtime/skills/", "runtime/reflex.js"],
		};
	}

	return { check, checkWedged, noteResult, reset };
}
