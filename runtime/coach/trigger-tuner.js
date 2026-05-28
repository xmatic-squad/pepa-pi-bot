// Trigger tuner — periodic statistical sanity-check over the
// advisor_recommendations table.
//
// Replaces the old Pi-reflect "analyse your own pattern" loop with a
// deterministic local computation: no LLM call, no subscription, just
// SQL. Every TUNE_INTERVAL_MS the tuner reads the last 24h of
// recommendations, groups by trigger_reason, and flags two failure
// modes as improvement_requests for the operator:
//
//   1. low-success trigger: a trigger that fires often (≥ MIN_SAMPLE)
//      but lands a successful outcome < SUCCESS_FLOOR of the time.
//      The threshold probably needs tuning, or the prompt isn't giving
//      the LLM the right hint.
//   2. expensive trigger: trigger averages > EXPENSIVE_TOKENS input
//      tokens but its success rate is mediocre. Could mean the prompt
//      includes context the LLM doesn't actually use.
//
// The tuner deduplicates via createImprovementRequest's votes mechanism
// — re-flagging the same gap just bumps the counter, not the row count.

import {
	isAvailable as knowledgeAvailable,
	recommendationStats,
	createImprovementRequest,
} from "../knowledge/index.js";
import { info, warn } from "../log.js";

const TUNE_INTERVAL_MS = 60 * 60 * 1000;   // 1 hour
const MIN_SAMPLE = 5;
const SUCCESS_FLOOR = 0.25;
const EXPENSIVE_TOKENS = 1000;
const EXPENSIVE_SUCCESS_CEILING = 0.5;

let _timer = null;

export function attach({ intervalMs = TUNE_INTERVAL_MS } = {}) {
	if (_timer) {
		warn("tuner", "attach called twice; ignoring");
		return;
	}
	_timer = setInterval(() => {
		// runOnce is synchronous (pure SQL, no await) — must NOT call
		// .catch on its plain-object return. A try/catch here is the
		// correct guard. (This exact bug crashed the live bot after
		// ~1h uptime when the first tuner tick fired.)
		try {
			runOnce();
		} catch (e) {
			warn("tuner", `tick err: ${e?.message ?? e}`);
		}
	}, intervalMs);
	_timer.unref?.();
	info("tuner", `attached; tune every ${Math.round(intervalMs / 60000)} min`);
}

export function detach() {
	if (_timer) clearInterval(_timer);
	_timer = null;
}

export function runOnce({ stats = null } = {}) {
	if (!knowledgeAvailable()) return { ok: false, reason: "knowledge unavailable" };

	const rows = stats ?? recommendationStats({ sinceHours: 24 });
	if (!rows.length) return { ok: true, flagged: 0, reason: "no data" };

	const flagged = [];
	for (const row of rows) {
		const sample = (row.applied ?? 0);
		if (sample < MIN_SAMPLE) continue;
		const succ = row.succeeded ?? 0;
		const successRate = sample === 0 ? 0 : succ / sample;

		// 1. Low success → tune the trigger
		if (successRate < SUCCESS_FLOOR) {
			const title = `Trigger "${row.trigger_reason}" has low success rate`;
			createImprovementRequest({
				source: "tuner",
				category: "tuning",
				title,
				description: `Over the last 24h, ${sample} applied recommendations from trigger ${row.trigger_reason} produced only ${succ} successful outcomes (${(successRate * 100).toFixed(0)}%). Consider tightening the trigger condition, improving the prompt, or adjusting the threshold.`,
				context: { stats: row },
				priority: 2,
			});
			flagged.push({ kind: "low_success", trigger: row.trigger_reason, sample, succ });
			continue;
		}

		// 2. Expensive prompt with mediocre payoff
		const avgIn = row.avg_in ?? 0;
		if (avgIn > EXPENSIVE_TOKENS && successRate < EXPENSIVE_SUCCESS_CEILING) {
			const title = `Trigger "${row.trigger_reason}" prompt is expensive`;
			createImprovementRequest({
				source: "tuner",
				category: "tuning",
				title,
				description: `Trigger ${row.trigger_reason} averages ${Math.round(avgIn)} input tokens but lands successful outcomes only ${(successRate * 100).toFixed(0)}% of the time (${succ}/${sample}). The prompt may include context the model doesn't use — consider trimming.`,
				context: { stats: row },
				priority: 4,
			});
			flagged.push({ kind: "expensive_prompt", trigger: row.trigger_reason, avgIn });
		}
	}
	if (flagged.length > 0) {
		info("tuner", `flagged ${flagged.length} improvement(s) from ${rows.length} trigger group(s)`);
	}
	return { ok: true, flagged: flagged.length, items: flagged, groups: rows.length };
}

// Test exports
export const __testing = { TUNE_INTERVAL_MS, MIN_SAMPLE, SUCCESS_FLOOR, EXPENSIVE_TOKENS };
