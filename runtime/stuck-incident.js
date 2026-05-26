// Stuck-incident detector. Today's failure-tracker in bot.js fires
// proposals on repeated *exception-class* failures (TypeError, timeout).
// This module fires on "no-progress" stagnation — the bot is healthy and
// the reflex loop hasn't crashed, but a single reason code (e.g.
// no_food_source, planner_empty) keeps coming back tick after tick.
//
// Before a proposal is filed, an optional critic pass (runtime/critic.js,
// adapted from Voyager) gets one Pi roundtrip to judge whether the bot
// actually failed. critic.success=true short-circuits the proposal (the
// bot has already recovered between the detector tripping and now);
// critic.success=false embeds the critique in the proposal body so the
// downstream auto-patcher has a sharp spec instead of raw metrics.
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

		const body = renderActionTemplate({
			title: `Stuck on \`${reason}\``,
			lede: `The runtime has reported the same no-progress reason for >${Math.round(thresholdMs / 60000)} min without a productive action.`,
			task: milestone?.title ?? "(no active milestone)",
			suggestedSkill: suggested,
			lastResult,
			executionError: lastResult?.detail ?? null,
			state: slim,
			metrics: metricsLine,
			journal: journalLine,
			scenarioTail: scenarioLines,
			editScope,
			fixGuidance: suggested
				? `Improve \`${suggested}\` so the bot can clear the \`${reason}\` blocker, OR teach a NEW skill that handles this kind of situation if no single edit fixes it. Touch only the listed files (the test files under runtime/**/*.test.js are auto-allowed). Use the scenario-memory entries above to avoid re-introducing patterns that already failed.`
				: `The curriculum has no suggested skill for this state. Either teach the curriculum a new milestone OR add a recovery skill that turns this reason code into a productive action. The scenario memory above shows what's been tried.`,
		});

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

		const body = renderActionTemplate({
			title: "Wedged — escape-pit cannot extract the bot",
			lede: `The bot has produced ${WEDGED_FIRE_AT}+ "wedged-jump / escape-pit / blind" completions in a row. In-world it stands still; the existing escape primitives are not enough.`,
			task: "free the bot from its current 1×1 wedge",
			suggestedSkill: "recovery.tunnel-out",
			lastResult,
			executionError: lastResult?.detail ?? null,
			state: slim,
			metrics: metricsLine,
			journal: journalLine,
			scenarioTail: scenarioLines,
			editScope: ["runtime/actions.js", "runtime/skills/", "runtime/reflex.js"],
			fixGuidance: "Either improve `escapePit()` in `runtime/actions.js` (e.g. dig forward + down + side, not only up) OR add a NEW skill `recovery.tunnel-out` that breaks the bot out of a 1×1 hole by digging a 3-block tunnel in the most-free cardinal. Add tests under `runtime/skills/`.",
		});

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

// Render a proposal body in the Voyager action_template.txt schema —
// Task / Last action / Execution error / Current state / Metrics /
// World journal / Scenario memory / Edit scope / Suggested fix /
// Forbidden. The fixed section order trains Pi to scan a familiar
// layout instead of re-parsing ad-hoc Markdown each time.
export function renderActionTemplate({
	title,
	lede,
	task,
	suggestedSkill,
	lastResult,
	executionError,
	state,
	metrics,
	journal,
	scenarioTail,
	editScope,
	fixGuidance,
}) {
	const lastResultLine = lastResult
		? `\`${lastResult.label}\` → ${lastResult.code ?? (lastResult.ok ? "ok" : "fail")}${lastResult.detail ? ` (${JSON.stringify(lastResult.detail).slice(0, 200)})` : ""}`
		: "_(none recorded)_";
	const errLine = executionError
		? (typeof executionError === "string" ? executionError : JSON.stringify(executionError)).slice(0, 300)
		: "_(none)_";
	return [
		`# ${title}`,
		"",
		lede,
		"",
		"## Task",
		"",
		`- **goal**: ${task}`,
		`- **suggested skill**: ${suggestedSkill ? `\`${suggestedSkill}\`` : "_(none — propose one)_"}`,
		"",
		"## Last action result",
		"",
		lastResultLine,
		"",
		"## Execution error",
		"",
		errLine,
		"",
		"## Current state",
		"",
		"```json",
		JSON.stringify(state, null, 2),
		"```",
		"",
		"## Skill metrics (this process lifetime)",
		"",
		metrics,
		"",
		"## World journal (what we have discovered so far)",
		"",
		journal,
		"",
		"## Scenario memory (last attempts in similar situations)",
		"",
		scenarioTail,
		"",
		"## Suggested fix",
		"",
		fixGuidance,
		"",
		"## Edit scope (auto-patch must obey this)",
		"",
		(editScope || []).map((p) => `- ${p}`).join("\n"),
		"",
		"## Forbidden",
		"",
		"- Don't touch `.env`, `state/`, `extensions/`, `tui/` unless the scope above includes them.",
		"- Don't add new npm dependencies.",
		"- Don't change git history (no `--amend`, no `git reset --hard`).",
		"",
	].join("\n");
}

// Splice a Voyager-style critic block into a proposal body. Inserted just
// before the "## Suggested fix" header so Pi sees the critic's surgical
// hint before its own guidance.
export function attachCritique(body, critique) {
	if (!critique) return body;
	const block = [
		"## Critic (Pi pre-flight judgement)",
		"",
		`- **reasoning**: ${critique.reasoning || "(none)"}`,
		`- **success-already**: ${critique.success}`,
		`- **critique**: ${critique.critique || "(none)"}`,
		critique.durationMs != null ? `- _critic took ${critique.durationMs}ms_` : null,
		"",
	].filter(Boolean).join("\n");
	const marker = "## Suggested fix";
	const idx = body.indexOf(marker);
	if (idx < 0) return `${body}\n\n${block}`;
	return `${body.slice(0, idx)}${block}\n${body.slice(idx)}`;
}

