// Self-reflection loop. Every REFLECT_INTERVAL_MS (default 30 min) we ask
// Pi a meta-question: "Look at the last window of activity. Are you in a
// loop? Making progress? What should you do differently?"
//
// The answer is parsed into:
//   - one short verdict ('progress' | 'loop' | 'recovering' | 'idle')
//   - a paragraph of context (stored to state/<host>/reflections/<ts>.md)
//   - optional new lessons (written to knowledge.lessons)
//   - optional plan adjustment (queued, not auto-applied)
//
// This is the proactive counterpart to coach/postmortem (which is reactive
// — fires on death). Together they cover both "I just lost" and "I haven't
// gained anything in a while" failure modes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { isAvailable as knowledgeAvailable, record as recordLesson, createImprovementRequest } from "../knowledge/index.js";
import { isRegistered, skillRegistryPrompt } from "../skill-registry.js";
import { pickActiveNeed } from "../manifesto/state.js";
import { isAvailable as llmAvailable } from "../llm/provider.js";
import { askAnalytical } from "./llm-call.js";
import { info, warn } from "../log.js";

// Mode-name allow-list, mirrors postmortem.js (advice.js maps them to
// real skills at consult-time). Anything else is hallucination → dropped.
const KNOWN_MODE_NAMES = new Set([
	"self_preservation", "night_shelter", "hunger", "shelter",
	"flee", "sleep", "eat", "tunnel_out", "tunnel-out", "explore", "wander",
]);
function isLikelyModeName(s) {
	if (!s || typeof s !== "string") return false;
	return KNOWN_MODE_NAMES.has(s.toLowerCase().trim());
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const HOURLY_BUDGET = 2;
const HISTORY_TAIL_LINES = 80;

let _attached = null;
let _timer = null;
let _llmCallTimes = [];

export function attach({ bot, stateDir, getSnapshot, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
	if (_attached) {
		warn("reflect", "attach called twice; ignoring");
		return;
	}
	if (!stateDir || !getSnapshot) {
		info("reflect", "attach: missing stateDir/getSnapshot — disabled");
		return;
	}
	_attached = { bot, stateDir, getSnapshot };
	_timer = setInterval(() => {
		runOnce({ stateDir, getSnapshot }).catch((e) =>
			warn("reflect", `tick err: ${e?.message ?? e}`),
		);
	}, intervalMs);
	_timer.unref?.();
	info("reflect", `attached; self-assess every ${Math.round(intervalMs / 60000)} min${llmAvailable() ? " (TimeWeb)" : " (LLM disabled — will skip)"}`);
}

export function detach() {
	if (_timer) clearInterval(_timer);
	_timer = null;
	_attached = null;
}

export async function runOnce({ stateDir, getSnapshot, force = false, askAnalyticalFn = askAnalytical } = {}) {
	const now = Date.now();
	const hourAgo = now - 3600_000;
	_llmCallTimes = _llmCallTimes.filter((t) => t > hourAgo);
	if (!llmAvailable()) return { ok: false, reason: "llm not configured" };
	if (!force && _llmCallTimes.length >= HOURLY_BUDGET) {
		return { ok: false, reason: "budget exhausted", calls: _llmCallTimes.length };
	}

	const snap = getSnapshot();
	const journal = readJournalTail(stateDir);
	const scenarios = readScenarioTail(stateDir);
	const diary = readDiaryTail(stateDir);
	const plan = readPlan(stateDir);
	const activeNeed = pickActiveNeed(snap);

	const { system, user } = buildPrompt({ snap, journal, scenarios, diary, plan, activeNeed });
	_llmCallTimes.push(now);

	const parsed = await askAnalyticalFn({ system, user, json: true });
	if (!parsed || typeof parsed !== "object") return { ok: false, reason: "no reply" };
	const reply = JSON.stringify(parsed);

	const path = writeReflection(stateDir, parsed, reply);
	let rejectedPrefer = 0;
	for (const l of asArray(parsed.lessons)) {
		if (!l?.lesson) continue;
		let preferSkill = l.prefer_skill ?? null;
		if (preferSkill && !isRegistered(preferSkill) && !isLikelyModeName(preferSkill)) {
			rejectedPrefer += 1;
			preferSkill = null;
		}
		let avoidSkill = l.avoid_skill ?? null;
		if (avoidSkill && !isRegistered(avoidSkill) && !isLikelyModeName(avoidSkill)) {
			avoidSkill = null;
		}
		recordLesson({
			text: l.lesson,
			category: l.category ?? "self-improve",
			triggerSkill: l.trigger_skill ?? null,
			triggerHostile: l.trigger_hostile ?? null,
			avoidSkill,
			preferSkill,
			confidence: clamp(Number(l.confidence) || 0.5, 0.1, 0.9),
			source: "timeweb-reflect",
			sourceRef: path,
		});
	}
	if (rejectedPrefer > 0) {
		warn("reflect", `dropped prefer_skill from ${rejectedPrefer} reflection lessons (not in registry)`);
	}

	// v0.3.0 — improvement requests from reflection. The LLM is asked
	// to flag missing skills/features when self-reflection reveals a
	// systemic gap (e.g. "I keep failing iron tools because there's no
	// craft.iron-pickaxe skill").
	let improvementsCount = 0;
	for (const imp of asArray(parsed.improvements ?? [])) {
		if (!imp?.title) continue;
		createImprovementRequest({
			source: "reflect",
			category: imp.category ?? "skill",
			title: String(imp.title).slice(0, 120),
			description: imp.description ?? null,
			context: { verdict: parsed.verdict, reflection_path: path },
			priority: imp.priority ?? 3,
		});
		improvementsCount += 1;
	}

	info("reflect", `verdict=${parsed.verdict ?? "?"} ${parsed.summary?.slice(0, 80) ?? ""} lessons=${(parsed.lessons ?? []).length} improvements=${improvementsCount} (${path ?? "no file"})`);
	return { ok: true, verdict: parsed.verdict, summary: parsed.summary, lessons: parsed.lessons ?? [], improvements: improvementsCount };
}

function readJournalTail(stateDir) {
	const f = resolve(stateDir, "world-journal.jsonl");
	if (!existsSync(f)) return [];
	try {
		return readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-HISTORY_TAIL_LINES);
	} catch { return []; }
}

function readScenarioTail(stateDir) {
	const f = resolve(stateDir, "scenarios.jsonl");
	if (!existsSync(f)) return [];
	try {
		return readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-HISTORY_TAIL_LINES);
	} catch { return []; }
}

function readDiaryTail(stateDir) {
	const today = new Date().toISOString().slice(0, 10);
	const f = resolve(stateDir, "diary", `${today}.md`);
	if (!existsSync(f)) return "";
	try {
		const raw = readFileSync(f, "utf8");
		return raw.split("\n").slice(-40).join("\n");
	} catch { return ""; }
}

function readPlan(stateDir) {
	const f = resolve(stateDir, "plan.md");
	if (!existsSync(f)) return "";
	try { return readFileSync(f, "utf8"); } catch { return ""; }
}

function buildPrompt({ snap, journal, scenarios, diary, plan, activeNeed }) {
	const pos = snap?.position;
	const inv = snap?.inventory ? Object.keys(snap.inventory).slice(0, 12).join(", ") : "(empty)";
	const lastResult = snap?.lastResult ? JSON.stringify(snap.lastResult).slice(0, 200) : "(none)";
	const needLine = activeNeed
		? `L${activeNeed.need.level} ${activeNeed.need.id} → ${activeNeed.skillId} (${activeNeed.need.title})`
		: "(satisfied through L10 / no active need)";

	const system = [
		"You are pepa, an autonomous Minecraft survival bot, reflecting on your own progress.",
		"Answer honestly: are you making progress, stuck in a loop, or facing a structural gap?",
		"",
		skillRegistryPrompt({ limit: 1800 }),
		"",
		"Reply with ONE JSON object (no markdown fences, no prose):",
		'{',
		'  "verdict": "progress" | "loop" | "recovering" | "idle" | "emergency",',
		'  "summary": "<2-3 sentence honest assessment in Russian>",',
		'  "next_action": "<one-sentence directive>",',
		'  "lessons": [',
		'    { "lesson": "<≤30 words, generalised rule>",',
		'      "category": "combat|pathing|crafting|survival|self-improve",',
		'      "trigger_skill": "<skill id or null>",',
		'      "trigger_hostile": "<mob name or null>",',
		'      "avoid_skill": "<registered skill id or null>",',
		'      "prefer_skill": "<registered skill id or null>",',
		'      "confidence": 0.6 } ],',
		'  "improvements": [',
		'    { "title": "<≤80 chars: structural gap (e.g. \'No craft.iron-pickaxe skill\')>",',
		'      "description": "<concrete example showing why no registered skill helps>",',
		'      "category": "skill|tuning|perception|planning|social|other",',
		'      "priority": 1 } ]',
		'}',
		"",
		"CRITICAL: avoid_skill and prefer_skill MUST be one of the registered ids above, or null.",
		"Use 'improvements' ONLY when you identify a structural gap — a missing skill or feature that would unblock a class of situations. Skip it otherwise.",
	].join("\n");

	const user = [
		"## Current state",
		`- position: ${pos ? `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : "?"}`,
		`- hp: ${snap?.health ?? "?"} food: ${snap?.food ?? "?"} day: ${snap?.isDay ? "yes" : "no"}`,
		`- runtimeState: ${snap?.runtimeState ?? "?"}`,
		`- activeSkill: ${snap?.activeSkill ?? "(idle)"}`,
		`- activeNeed (Maslow ladder L0-L10): ${needLine}`,
		`- currentMilestone: ${snap?.currentMilestone ?? "?"}`,
		`- noProgressReason: ${snap?.noProgressReason ?? "(none)"}`,
		`- lastResult: ${lastResult}`,
		`- inventory keys: ${inv}`,
		"",
		"## plan.md",
		"```",
		plan.slice(0, 1200),
		"```",
		"",
		"## diary tail",
		"```",
		diary.slice(0, 1500),
		"```",
		"",
		"## recent scenarios (tail)",
		"```",
		scenarios.slice(-30).join("\n"),
		"```",
		"",
		"## world-journal tail",
		"```",
		journal.slice(-20).join("\n"),
		"```",
	].join("\n");

	return { system, user };
}

function parseReply(text) {
	if (!text) return null;
	const cleaned = text.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
	try { return JSON.parse(cleaned); } catch {}
	const m = cleaned.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try { return JSON.parse(m[0]); } catch { return null; }
}

function writeReflection(stateDir, parsed, raw) {
	try {
		const dir = resolve(stateDir, "reflections");
		mkdirSync(dir, { recursive: true });
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const file = resolve(dir, `${ts}.md`);
		const body = [
			"---",
			`verdict: ${parsed.verdict ?? "unknown"}`,
			`ts: ${new Date().toISOString()}`,
			"---",
			"",
			`## Summary`,
			"",
			parsed.summary ?? "(empty)",
			"",
			`## Next action`,
			"",
			parsed.next_action ?? "(none)",
			"",
			`## Lessons`,
			"",
			...(asArray(parsed.lessons).map((l, i) => [
				`### ${i + 1}. ${l?.lesson ?? "(empty)"}`,
				`category: ${l?.category ?? "?"}, confidence: ${l?.confidence ?? "?"}`,
				l?.avoid_skill ? `avoid: ${l.avoid_skill}` : null,
				l?.prefer_skill ? `prefer: ${l.prefer_skill}` : null,
				"",
			].filter(Boolean).join("\n"))),
			"",
			"## Raw response",
			"",
			"```",
			raw.slice(0, 8000),
			"```",
		].join("\n");
		writeFileSync(file, body);
		return file;
	} catch (e) {
		warn("reflect", `writeReflection failed: ${e?.message ?? e}`);
		return null;
	}
}

function asArray(v) { return Array.isArray(v) ? v : v ? [v] : []; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Test exports
export const __testing = { buildPrompt, parseReply };
