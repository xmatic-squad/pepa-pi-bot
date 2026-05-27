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

import { isAvailable as knowledgeAvailable, record as recordLesson } from "../knowledge/index.js";
import { isRegistered, skillRegistryPrompt } from "../skill-registry.js";
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
let _piCallTimes = [];

export function attach({ bot, stateDir, askPi, getSnapshot, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
	if (_attached) {
		warn("reflect", "attach called twice; ignoring");
		return;
	}
	if (!stateDir || !askPi || !getSnapshot) {
		info("reflect", "attach: missing stateDir/askPi/getSnapshot — disabled");
		return;
	}
	_attached = { bot, stateDir, askPi, getSnapshot };
	_timer = setInterval(() => {
		runOnce({ stateDir, askPi, getSnapshot }).catch((e) =>
			warn("reflect", `tick err: ${e?.message ?? e}`),
		);
	}, intervalMs);
	_timer.unref?.();
	info("reflect", `attached; self-assess every ${Math.round(intervalMs / 60000)} min`);
}

export function detach() {
	if (_timer) clearInterval(_timer);
	_timer = null;
	_attached = null;
}

export async function runOnce({ stateDir, askPi, getSnapshot, force = false } = {}) {
	const now = Date.now();
	const hourAgo = now - 3600_000;
	_piCallTimes = _piCallTimes.filter((t) => t > hourAgo);
	if (!force && _piCallTimes.length >= HOURLY_BUDGET) {
		return { ok: false, reason: "budget exhausted", calls: _piCallTimes.length };
	}

	const snap = getSnapshot();
	const journal = readJournalTail(stateDir);
	const scenarios = readScenarioTail(stateDir);
	const diary = readDiaryTail(stateDir);
	const plan = readPlan(stateDir);

	const prompt = buildPrompt({ snap, journal, scenarios, diary, plan });
	_piCallTimes.push(now);

	const reply = await askPiOnce({ askPi, prompt });
	if (!reply) return { ok: false, reason: "no reply" };

	const parsed = parseReply(reply);
	if (!parsed) {
		warn("reflect", "Pi reply not parseable as JSON");
		return { ok: false, reason: "bad reply", raw: reply.slice(0, 200) };
	}

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
			source: "pi-reflect",
			sourceRef: path,
		});
	}
	if (rejectedPrefer > 0) {
		warn("reflect", `dropped prefer_skill from ${rejectedPrefer} reflection lessons (not in registry)`);
	}
	info("reflect", `verdict=${parsed.verdict ?? "?"} ${parsed.summary?.slice(0, 80) ?? ""} (${path ?? "no file"})`);
	return { ok: true, verdict: parsed.verdict, summary: parsed.summary, lessons: parsed.lessons ?? [] };
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

function buildPrompt({ snap, journal, scenarios, diary, plan }) {
	const pos = snap?.position;
	const inv = snap?.inventory ? Object.keys(snap.inventory).slice(0, 12).join(", ") : "(empty)";
	const lastResult = snap?.lastResult ? JSON.stringify(snap.lastResult).slice(0, 200) : "(none)";
	return [
		"You are pepa, an autonomous Minecraft survival bot, reflecting on your own progress.",
		"Look at the last ~30 minutes of activity below. Answer honestly: are you actually making progress, or stuck in a loop?",
		"",
		skillRegistryPrompt({ limit: 1800 }),
		"",
		"## Current state",
		`- position: ${pos ? `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` : "?"}`,
		`- hp: ${snap?.health ?? "?"} food: ${snap?.food ?? "?"} day: ${snap?.isDay ? "yes" : "no"}`,
		`- runtimeState: ${snap?.runtimeState ?? "?"}`,
		`- activeSkill: ${snap?.activeSkill ?? "(idle)"}`,
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
		"",
		"Reply with ONE JSON object (no markdown fences, no prose):",
		'{',
		'  "verdict": "progress" | "loop" | "recovering" | "idle" | "emergency",',
		'  "summary": "<2-3 sentence honest assessment in Russian>",',
		'  "next_action": "<one-sentence directive for what to do next>",',
		'  "lessons": [',
		'    { "lesson": "<≤30 words, generalised rule>",',
		'      "category": "combat|pathing|crafting|survival|self-improve",',
		'      "trigger_skill": "<skill id or null>",',
		'      "trigger_hostile": "<mob name or null>",',
		'      "avoid_skill": "<registered skill id to avoid or null>",',
		'      "prefer_skill": "<registered skill id to use instead or null>",',
		'      "confidence": 0.6 }',
		'  ]',
		'}',
		"",
		"If you're clearly in a loop (same activity, no inventory growth, same position), say so honestly.",
		"If you're stuck in a bad terrain (deep pit, hostile-rich area), recommend choosing a new base.",
		"Lessons should be SHORT and ACTIONABLE. Don't repeat lessons the dispatcher already learned.",
		"CRITICAL: avoid_skill and prefer_skill MUST be one of the registered ids listed at the top of this prompt, or null. Do NOT invent new ids.",
	].join("\n");
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

function askPiOnce({ askPi, prompt }) {
	return new Promise((res) => {
		let buf = "";
		try {
			askPi({
				prompt,
				onChunk: ({ stream, text }) => { if (stream === "stdout") buf += text; },
				onDone: () => res(buf),
			});
		} catch (e) {
			warn("reflect", `askPi: ${e?.message ?? e}`);
			res(null);
		}
	});
}

function asArray(v) { return Array.isArray(v) ? v : v ? [v] : []; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Test exports
export const __testing = { buildPrompt, parseReply };
