// Shared helper for the slow-analytical coach loops (postmortem.js,
// reflect.js). Replaces the old askPi-based subprocess path with a
// direct TimeWeb / OpenAI-compatible HTTP call.
//
// Why this split: postmortem and reflect each took 5-15s via Pi CLI
// (with its own subprocess + auth + sometimes a fresh MC connection)
// and were rate-limited by the subscription. Now they take 5-15s via
// the same TimeWeb endpoint the fast-advisor uses — but they're
// analytical, NOT tactical, so they ask for a different prompt shape
// and a longer reply.
//
// The Pi CLI is no longer driven from background timers. It remains
// available for manual operator commands.

import { complete } from "../llm/provider.js";
import { warn } from "../log.js";

const ANALYTICAL_TIMEOUT_MS = 30_000;

/**
 * askAnalytical({ system, user, json }) → text|object|null
 *
 * Higher-timeout, lower-temperature companion to fast-advisor's
 * complete(). Returns just the parsed text/object on success or null
 * on failure (so callers can keep their old "no reply" branch).
 *
 * Token usage is logged via the underlying provider — no extra
 * accounting here.
 */
export async function askAnalytical({ system, user, json = true, timeoutMs } = {}) {
	const res = await complete({
		system,
		user,
		json,
		timeoutMs: timeoutMs ?? ANALYTICAL_TIMEOUT_MS,
	});
	if (!res.ok) {
		warn("coach-llm", `analytical call failed: ${res.code} (${res.detail})`);
		return null;
	}
	return res.text;
}

export { ANALYTICAL_TIMEOUT_MS };
