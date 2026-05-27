// Fast tactical advisor — second LLM tier, parallel to Pi.
//
// Pi (the CLI coach) is great for deep post-mortems and 30-min reflection,
// but it's slow (5-15s) and rate-limited. When the reflex detects the bot
// is wedged, stuck, or just took an environment shock (forced teleport,
// HP plunge, hostile spawn), we want a sub-2-second "what do I do?"
// answer from a cheap, hosted model. That's this module.
//
// In rc.1 this is a scaffold: complete() + advise() + rate-limiting +
// integration tests, but no auto-trigger from the reflex yet. rc.3 wires
// the trigger paths (awareness layer) into here.
//
// The advisor MUST return a JSON shape whose `prefer_skill` field is a
// real, registered skill id — anything else is rejected. The system
// prompt embeds the live registry so the model has the source of truth.

import { complete, isAvailable as llmAvailable } from "../llm/provider.js";
import { isRegistered, skillRegistryPrompt } from "../skill-registry.js";
import { info, warn } from "../log.js";

const HOURLY_BUDGET = 6;
const COOLDOWN_MS = 30_000;

let _callTimes = [];
let _lastCallAt = 0;
let _tokensIn = 0;
let _tokensOut = 0;
let _calls = 0;

export function isAvailable() {
	return llmAvailable();
}

export function getUsageSnapshot() {
	const now = Date.now();
	const hourAgo = now - 3600_000;
	const recentCalls = _callTimes.filter((t) => t > hourAgo).length;
	return {
		callsLastHour: recentCalls,
		callsTotal: _calls,
		tokensInTotal: _tokensIn,
		tokensOutTotal: _tokensOut,
		hourlyBudget: HOURLY_BUDGET,
	};
}

export function _resetForTest() {
	_callTimes = [];
	_lastCallAt = 0;
	_tokensIn = 0;
	_tokensOut = 0;
	_calls = 0;
}

/**
 * advise({ snapshot, reason, recentSkillIds, lessonsTail }) →
 *   { ok: true, action: 'switch_skill'|'continue'|'wait', skillId?, rationale, raw, latencyMs }
 *   | { ok: false, code, detail, latencyMs }
 *
 * `reason` is a free-text trigger ("wedged_60s", "forced_move",
 * "hp_plunge", "stuck_3_dispatches"). It goes verbatim into the prompt
 * so the model can tailor its advice.
 */
export async function advise({
	snapshot,
	reason = "unknown",
	recentSkillIds = [],
	lessonsTail = [],
	activeNeed = null,
	storyStep = null,
	force = false,
} = {}) {
	if (!isAvailable()) {
		return { ok: false, code: "not_configured", detail: "set TIMEWEB_API_KEY", latencyMs: 0 };
	}

	const now = Date.now();
	_callTimes = _callTimes.filter((t) => t > now - 3600_000);
	if (!force && _callTimes.length >= HOURLY_BUDGET) {
		return { ok: false, code: "budget_exhausted", detail: `${_callTimes.length}/${HOURLY_BUDGET} per hour`, latencyMs: 0 };
	}
	if (!force && now - _lastCallAt < COOLDOWN_MS) {
		return { ok: false, code: "cooldown", detail: `${Math.round((COOLDOWN_MS - (now - _lastCallAt)) / 1000)}s`, latencyMs: 0 };
	}

	const system = buildSystemPrompt();
	const user = buildUserPrompt({ snapshot, reason, recentSkillIds, lessonsTail, activeNeed, storyStep });

	_callTimes.push(now);
	_lastCallAt = now;

	const res = await complete({ system, user, json: true });
	_calls += 1;
	if (res.usage) {
		_tokensIn += res.usage.in;
		_tokensOut += res.usage.out;
	}
	if (!res.ok) {
		warn("advisor", `complete failed: ${res.code} (${res.detail})`);
		return { ok: false, code: res.code, detail: res.detail, latencyMs: res.latencyMs };
	}

	const parsed = res.text;
	if (!parsed || typeof parsed !== "object") {
		return { ok: false, code: "bad_shape", detail: "no object in reply", latencyMs: res.latencyMs };
	}

	const action = String(parsed.action ?? "").toLowerCase();
	const skillId = parsed.skill_id ?? parsed.prefer_skill ?? null;
	const rationale = parsed.rationale ?? parsed.reason ?? "";

	if (action === "switch_skill") {
		if (!skillId || !isRegistered(skillId)) {
			warn("advisor", `rejected hallucinated skill "${skillId}"`);
			return {
				ok: false,
				code: "hallucinated_skill",
				detail: skillId ?? "(null)",
				rationale,
				raw: parsed,
				latencyMs: res.latencyMs,
				usage: res.usage,
			};
		}
		info("advisor", `switch_skill → ${skillId} (${rationale.slice(0, 80)})`);
		return {
			ok: true,
			action: "switch_skill",
			skillId,
			rationale,
			raw: parsed,
			latencyMs: res.latencyMs,
			usage: res.usage,
		};
	}

	if (action === "continue" || action === "wait") {
		info("advisor", `${action} (${rationale.slice(0, 80)})`);
		return { ok: true, action, rationale, raw: parsed, latencyMs: res.latencyMs, usage: res.usage };
	}

	return { ok: false, code: "bad_action", detail: action || "missing", raw: parsed, latencyMs: res.latencyMs, usage: res.usage };
}

function buildSystemPrompt() {
	return [
		"You are the tactical advisor for pepa, an autonomous Minecraft survival bot.",
		"You are called when the bot's reflex layer detects something wrong (wedged, stuck,",
		"forced move, HP plunge). Your job: produce a single fast decision.",
		"",
		"Reply STRICTLY with a JSON object:",
		'{',
		'  "action": "switch_skill" | "continue" | "wait",',
		'  "skill_id": "<registered skill id or null>",',
		'  "rationale": "<≤25 words explaining why>"',
		'}',
		"",
		"Rules:",
		'- "switch_skill" REQUIRES skill_id to be one of the registered ids below.',
		'- "continue" means current skill is fine, just give it more time.',
		'- "wait" means stop dispatching for ~10s (e.g. waiting for night to pass).',
		'- If unsure, return "continue".',
		"",
		skillRegistryPrompt({ limit: 1800 }),
	].join("\n");
}

function buildUserPrompt({ snapshot, reason, recentSkillIds, lessonsTail, activeNeed, storyStep }) {
	const pos = snapshot?.position;
	const inv = snapshot?.inventory ? Object.keys(snapshot.inventory).slice(0, 10).join(", ") : "(empty)";
	const recent = (recentSkillIds ?? []).slice(-8).join(" → ") || "(none)";
	const lessons = (lessonsTail ?? []).slice(0, 4).map((l) => `  - ${l.text ?? l}`).join("\n");
	const needLine = activeNeed
		? `L${activeNeed.need.level} ${activeNeed.need.id} (${activeNeed.need.title}) — manifesto wants ${activeNeed.skillId}`
		: "(no active need)";
	const storyLine = storyStep
		? `step ${storyStep.index + 1} '${storyStep.step.id}' — ${storyStep.step.title}${storyStep.suggestion?.skillId ? ` (storyline wants ${storyStep.suggestion.skillId})` : ""}${storyStep.emergency ? " [EMERGENCY PAUSE]" : ""}`
		: "(no current step)";
	const hostile = snapshot?.closestHostile
		? `${snapshot.closestHostile.name}@${snapshot.closestHostile.distance}b`
		: "(none)";

	return [
		`Trigger: ${reason}`,
		`Position: ${pos ? `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : "?"}`,
		`HP: ${snapshot?.health ?? "?"} food: ${snapshot?.food ?? "?"} day: ${snapshot?.isDay ? "yes" : "no"}`,
		`Storyline progress: ${storyLine}`,
		`Active need (Maslow ladder): ${needLine}`,
		`Closest hostile: ${hostile}`,
		`Active skill: ${snapshot?.activeSkill ?? "(idle)"}`,
		`Recent dispatches: ${recent}`,
		`Inventory keys: ${inv}`,
		`Nearby threats: ${formatThreats(snapshot?.threats)}`,
		`No-progress reason: ${snapshot?.noProgressReason ?? "(none)"}`,
		"",
		lessons ? `Relevant lessons:\n${lessons}\n` : "",
		"What should the bot do RIGHT NOW? Return the JSON decision.",
		"Prefer a skill that advances the current storyline step. If a manifesto emergency fires, that wins over both. Don't repeat a skill that has been failing in the recent dispatches list.",
	].filter(Boolean).join("\n");
}

function formatThreats(threats) {
	if (!Array.isArray(threats) || threats.length === 0) return "(none)";
	return threats.slice(0, 3).map((t) => `${t.name ?? "?"}@${Math.round(t.distance ?? 0)}m`).join(", ");
}

// Test exports
export const __testing = { buildSystemPrompt, buildUserPrompt, formatThreats, HOURLY_BUDGET, COOLDOWN_MS };
