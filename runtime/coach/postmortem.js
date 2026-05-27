// Death post-mortem coach.
//
// On every `bot.death` event we capture the surrounding context (last
// skill, last hostile, recent log/scenario tail, inventory before/after)
// and write a row into the `deaths` table of the knowledge DB.
//
// A separate slow loop drains `unanalysedDeaths()` and asks Pi to extract
// generalised lessons. Pi calls are rate-limited and deduped — many
// near-identical deaths produce ONE lesson, not 50.
//
// Lessons land in the `lessons` table and feed runtime/knowledge/recall()
// for future skill dispatch decisions.
//
// This file is import-safe: side-effect-free, attaches only when
// `attach(bot, ctx)` is called explicitly from bot.js.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	isAvailable as knowledgeAvailable,
	insertDeath,
	insertPostmortem,
	markDeathAnalysed,
	unanalysedDeaths,
	record as recordLesson,
	poiNearby,
	recordPOI,
	createImprovementRequest,
} from "../knowledge/index.js";
import { isRegistered, skillRegistryPrompt } from "../skill-registry.js";
import { isAvailable as llmAvailable } from "../llm/provider.js";
import { askAnalytical } from "./llm-call.js";
import { info, warn } from "../log.js";

const COACH_INTERVAL_MS = 5 * 60 * 1000;   // 5 min between coach passes
const COACH_BATCH_MAX = 8;                  // up to 8 deaths per LLM call
const COACH_BUDGET_PER_HOUR = 3;            // ≤ 3 analytical LLM calls/hour
const COACH_COOLDOWN_MS = 12 * 60 * 1000;   // 12 min between calls
const RECENT_CHAT_TAIL = 6;
const SCENARIO_TAIL = 12;

let _attached = null;
let _llmCallTimes = [];
let _coachTimer = null;
let _lastInventory = null;

export function attach(bot, ctx = {}) {
	if (_attached) {
		warn("coach", "attach() called twice; ignoring second attach");
		return;
	}
	if (!bot) return;
	_attached = { bot, ctx };

	// Snapshot inventory each tick (cheap) so death captures what was lost.
	bot.on?.("playerCollect", () => { _lastInventory = snapshotInv(bot); });
	bot.on?.("spawn", () => { _lastInventory = snapshotInv(bot); });

	bot.on?.("death", () => {
		try {
			const death = captureDeath(bot, ctx);
			if (!death) return;
			const deathId = insertDeath(death);
			info("coach", `death recorded id=${deathId ?? "-"} cause=${death.cause} hostile=${death.hostile ?? "?"} skill=${death.lastSkill ?? "?"}`);
			// v0.2.0-rc.3 — mark this spot as a danger POI so spatial recall
			// surfaces it next time the bot comes near. Expires after 6 hours
			// so the danger doesn't outlive its relevance.
			if (typeof death.x === "number" && typeof death.z === "number") {
				recordPOI({
					kind: "danger",
					name: death.hostile ?? death.cause ?? "death",
					x: death.x, y: death.y ?? 64, z: death.z,
					expiresAt: Date.now() + 6 * 3600_000,
					notes: `death id=${deathId} cause=${death.cause}`,
				});
			}
		} catch (e) {
			warn("coach", `captureDeath failed: ${e?.message ?? e}`);
		}
	});

	// v0.3.0 — postmortem analysis runs through TimeWeb (the fast LLM
	// provider). Pi CLI no longer drives this loop. The drain timer
	// fires regardless of whether TimeWeb is configured; drainOnce()
	// short-circuits when the LLM is unavailable.
	if (!_coachTimer) {
		_coachTimer = setInterval(() => {
			drainOnce({ stateDir: ctx.stateDir }).catch((e) =>
				warn("coach", `drain error: ${e?.message ?? e}`),
			);
		}, COACH_INTERVAL_MS);
		_coachTimer.unref?.();
		info("coach", `attached; drain every ${COACH_INTERVAL_MS / 1000}s${llmAvailable() ? " (TimeWeb)" : " (LLM disabled — deaths captured only)"}`);
	}
}

export function detach() {
	if (_coachTimer) {
		clearInterval(_coachTimer);
		_coachTimer = null;
	}
	_attached = null;
}

function snapshotInv(bot) {
	try {
		const items = bot.inventory?.items?.() ?? [];
		const dict = {};
		for (const i of items) dict[i.name] = (dict[i.name] || 0) + i.count;
		return dict;
	} catch {
		return null;
	}
}

function diffInv(before, after) {
	if (!before) return null;
	const lost = [];
	for (const [name, count] of Object.entries(before)) {
		const now = after?.[name] ?? 0;
		if (now < count) lost.push({ name, count: count - now });
	}
	return lost.length ? lost : null;
}

function captureDeath(bot, ctx) {
	const pos = bot.entity?.position;
	const lastInv = _lastInventory;
	const nowInv = snapshotInv(bot);
	const inventoryLost = diffInv(lastInv, nowInv);

	const currentTask = readCurrentTask(ctx.stateDir);
	const lastSkill = currentTask?.label ?? null;
	const lastSkillCode = currentTask?.lastCode ?? null;

	const hostile = closestHostileName(bot);
	const cause = inferCause({ bot, hostile, lastSkill, lastSkillCode });

	const recent = readRecentScenarios(ctx.stateDir, SCENARIO_TAIL);
	const journalNearby = readJournalNearby(ctx.stateDir, pos, 32);
	const chatTail = ctx.chatHistory?.recent?.(RECENT_CHAT_TAIL) ?? null;

	const contextBlob = {
		recentScenarios: recent,
		journalNearby,
		chatTail,
		snapshot: {
			pos,
			hp: bot.health,
			food: bot.food,
			time: bot.time?.timeOfDay ?? null,
			isRaining: !!bot.isRaining,
		},
	};

	return {
		ts: Date.now(),
		x: pos?.x ?? null,
		y: pos?.y ?? null,
		z: pos?.z ?? null,
		cause,
		hostile,
		lastSkill,
		lastSkillCode,
		hp: 0,
		food: bot.food ?? null,
		inventoryLost,
		contextBlob,
	};
}

function closestHostileName(bot) {
	try {
		const me = bot.entity?.position;
		if (!me) return null;
		let best = null;
		let bestDist = Infinity;
		for (const e of Object.values(bot.entities ?? {})) {
			if (!e || e === bot.entity) continue;
			if (e.type !== "hostile" && e.kind !== "Hostile mobs") continue;
			const d = e.position?.distanceTo?.(me) ?? Infinity;
			if (d < bestDist) {
				best = e.name ?? e.mobType ?? null;
				bestDist = d;
			}
		}
		return best;
	} catch {
		return null;
	}
}

function inferCause({ bot, hostile, lastSkill, lastSkillCode }) {
	const y = bot.entity?.position?.y;
	if (hostile) return "hostile";
	if (typeof bot.food === "number" && bot.food <= 0) return "starvation";
	if (typeof y === "number" && y < 30) return "fall";
	if (lastSkillCode === "drowning") return "drowning";
	if (lastSkillCode === "lava") return "lava";
	return "unknown";
}

function readCurrentTask(stateDir) {
	if (!stateDir) return null;
	const f = resolve(stateDir, "current-task.json");
	if (!existsSync(f)) return null;
	try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

function readRecentScenarios(stateDir, n) {
	if (!stateDir) return [];
	const f = resolve(stateDir, "scenarios.jsonl");
	if (!existsSync(f)) return [];
	try {
		const raw = readFileSync(f, "utf8");
		const lines = raw.split("\n").filter(Boolean);
		const tail = lines.slice(-n);
		return tail.map((l) => {
			try { return JSON.parse(l); } catch { return null; }
		}).filter(Boolean);
	} catch {
		return [];
	}
}

function readJournalNearby(stateDir, pos, radius) {
	if (!stateDir || !pos) return [];
	const f = resolve(stateDir, "world-journal.jsonl");
	if (!existsSync(f)) return [];
	try {
		const raw = readFileSync(f, "utf8");
		const lines = raw.split("\n").filter(Boolean).slice(-200);
		const out = [];
		for (const l of lines) {
			let row;
			try { row = JSON.parse(l); } catch { continue; }
			const a = row.at;
			if (!a) continue;
			const dx = a.x - pos.x;
			const dz = a.z - pos.z;
			if (dx * dx + dz * dz <= radius * radius) out.push(row);
		}
		return out.slice(-20);
	} catch {
		return [];
	}
}

/**
 * One pass: take up to COACH_BATCH_MAX unanalysed deaths, summarise them
 * for Pi, parse the JSON reply, write lessons + postmortems.
 *
 * Rate-limited: at most COACH_PI_BUDGET_PER_HOUR calls/hour, with
 * COACH_COOLDOWN_MS gap between calls.
 */
export async function drainOnce({ stateDir, force = false, askAnalyticalFn = askAnalytical } = {}) {
	if (!knowledgeAvailable()) return { ok: false, reason: "knowledge unavailable" };
	if (!llmAvailable()) return { ok: false, reason: "llm not configured" };

	const now = Date.now();
	const hourAgo = now - 60 * 60 * 1000;
	_llmCallTimes = _llmCallTimes.filter((t) => t > hourAgo);
	if (!force && _llmCallTimes.length >= COACH_BUDGET_PER_HOUR) {
		return { ok: false, reason: "hourly budget exhausted", calls: _llmCallTimes.length };
	}
	if (!force && _llmCallTimes.length > 0 && now - _llmCallTimes[_llmCallTimes.length - 1] < COACH_COOLDOWN_MS) {
		return { ok: false, reason: "cooldown" };
	}

	const pending = unanalysedDeaths({ limit: COACH_BATCH_MAX });
	if (pending.length === 0) return { ok: true, analysed: 0 };

	const { system, user } = buildPrompt(pending);
	_llmCallTimes.push(now);

	const parsed = await askAnalyticalFn({ system, user, json: true });
	if (!parsed) return { ok: false, reason: "no reply" };
	const reply = typeof parsed === "string" ? parsed : JSON.stringify(parsed);

	let lessonsCount = 0;
	let rejectedPreferCount = 0;
	for (const item of asArray(parsed.lessons ?? parsed)) {
		if (!item || !item.lesson) continue;
		// Skill ids referenced by Pi must be in the live registry.
		// Mode names (e.g. "night_shelter") are tolerated at write time and
		// translated at consult time by advice.js#normalisePreferSkill.
		let preferSkill = item.prefer_skill ?? null;
		if (preferSkill && !isRegistered(preferSkill) && !isLikelyModeName(preferSkill)) {
			rejectedPreferCount += 1;
			preferSkill = null;
		}
		let avoidSkill = item.avoid_skill ?? null;
		if (avoidSkill && !isRegistered(avoidSkill) && !isLikelyModeName(avoidSkill)) {
			avoidSkill = null;
		}
		recordLesson({
			text: item.lesson,
			category: item.category ?? "survival",
			triggerSkill: item.trigger_skill ?? null,
			triggerHostile: item.trigger_hostile ?? null,
			triggerSituation: item.trigger_situation ?? null,
			avoidSkill,
			preferSkill,
			confidence: clamp(Number(item.confidence) || 0.6, 0.1, 0.95),
			source: "pi-coach",
			sourceRef: item.source_ref ?? null,
		});
		lessonsCount += 1;
	}
	if (rejectedPreferCount > 0) {
		warn("coach", `dropped prefer_skill from ${rejectedPreferCount} lessons (not in registry)`);
	}

	// Write one postmortem per death; if grouped, share the same lesson.
	const groupLesson = parsed.lessons?.[0]?.lesson ?? parsed.lesson ?? null;
	for (const d of pending) {
		insertPostmortem({
			deathId: d.id,
			cause: parsed.cause ?? d.cause,
			lesson: groupLesson,
			nextAction: parsed.next_action ?? null,
			rawResponse: reply.slice(0, 4000),
			source: "timeweb",
		});
		markDeathAnalysed(d.id);
	}

	// v0.3.0 — record any improvement requests the LLM flagged. The
	// LLM is encouraged to do this when the deaths point to a missing
	// skill or feature; the operator reads scripts/list-improvements.js
	// and decides what to implement.
	let improvementsCount = 0;
	for (const imp of asArray(parsed.improvements ?? [])) {
		if (!imp?.title) continue;
		createImprovementRequest({
			source: "postmortem",
			category: imp.category ?? "skill",
			title: String(imp.title).slice(0, 120),
			description: imp.description ?? null,
			context: { death_ids: pending.map((d) => d.id), cause: parsed.cause },
			priority: imp.priority ?? 3,
		});
		improvementsCount += 1;
	}

	info("coach", `drain: analysed ${pending.length} deaths → ${lessonsCount} lessons, ${improvementsCount} improvement requests`);
	return { ok: true, analysed: pending.length, lessons: lessonsCount, improvements: improvementsCount };
}

// Mode names from runtime/modes.js (advice.js#MODE_TO_SKILL) — we accept
// these at write time because advice.js maps them to real skills at consult.
const KNOWN_MODE_NAMES = new Set([
	"self_preservation", "night_shelter", "hunger", "shelter",
	"flee", "sleep", "eat", "tunnel_out", "tunnel-out", "explore", "wander",
]);
function isLikelyModeName(s) {
	if (!s || typeof s !== "string") return false;
	return KNOWN_MODE_NAMES.has(s.toLowerCase().trim());
}

function buildPrompt(deaths) {
	const summary = deaths.map((d) => {
		const ctx = safeParse(d.context_blob);
		const tail = ctx?.recentScenarios ?? [];
		const tailFmt = tail.slice(-6).map((s) => `  - ${s.skillId} ${s.code}`).join("\n");
		return [
			`death id=${d.id} ts=${new Date(d.ts).toISOString()}`,
			`  position: (${Math.round(d.x ?? 0)}, ${Math.round(d.y ?? 0)}, ${Math.round(d.z ?? 0)})`,
			`  cause: ${d.cause}`,
			`  hostile: ${d.hostile ?? "(none)"}`,
			`  last skill: ${d.last_skill ?? "(none)"} (code: ${d.last_skill_code ?? "?"})`,
			`  hp at death: 0  food: ${d.food_at_death ?? "?"}`,
			tailFmt ? `  recent dispatches:\n${tailFmt}` : null,
		].filter(Boolean).join("\n");
	}).join("\n\n");

	const system = [
		"You are reviewing recent deaths of an autonomous Minecraft survival bot (pepa).",
		"The bot is trying to gather wood, craft tools, build a small village, and survive nights.",
		"Your job: extract 1-3 short, generalised lessons + flag any missing-skill gaps.",
		"",
		skillRegistryPrompt({ limit: 1800 }),
		"",
		"Reply with ONE JSON object (no markdown fences):",
		'{ "cause": "<short>", "next_action": "<one-sentence directive>",',
		'  "lessons": [',
		'    { "lesson": "...", "category": "combat|pathing|crafting|survival|social",',
		'      "trigger_skill": "<skill id or null>",',
		'      "trigger_hostile": "<mob name or null>",',
		'      "avoid_skill": "<registered skill id to NOT dispatch, or null>",',
		'      "prefer_skill": "<registered skill id to use instead, or null>",',
		'      "confidence": 0.7 } ],',
		'  "improvements": [',
		'    { "title": "<≤80 chars: what skill/feature is missing>",',
		'      "description": "<why current registry doesn\'t cover this; concrete example>",',
		'      "category": "skill|tuning|perception|planning|social|other",',
		'      "priority": 1 } ] }',
		"",
		"Keep each lesson under 30 words. Be specific.",
		"CRITICAL: avoid_skill and prefer_skill MUST be one of the registered ids above, or null.",
		"Use 'improvements' ONLY when a death is plausibly caused by the bot lacking a skill that doesn't exist in the registry (e.g. 'no skill to craft iron armor'). Skip it otherwise.",
	].join("\n");

	const user = `DEATHS:\n${summary}`;
	return { system, user };
}

function extractJson(text) {
	if (!text) return null;
	// Try to find a JSON object somewhere in the reply.
	const cleaned = text.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
	try { return JSON.parse(cleaned); } catch {}
	const m = cleaned.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try { return JSON.parse(m[0]); } catch { return null; }
}

function asArray(v) {
	if (Array.isArray(v)) return v;
	if (v && typeof v === "object") return [v];
	return [];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Test-only exports
export const __testing = { captureDeath, buildPrompt, extractJson, inferCause, isLikelyModeName, KNOWN_MODE_NAMES };
