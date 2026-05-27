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
} from "../knowledge/index.js";
import { info, warn } from "../log.js";

const COACH_INTERVAL_MS = 5 * 60 * 1000;   // 5 min between coach passes
const COACH_BATCH_MAX = 8;                  // up to 8 deaths per Pi call
const COACH_PI_BUDGET_PER_HOUR = 3;         // ≤ 3 Pi calls/hour
const COACH_COOLDOWN_MS = 12 * 60 * 1000;   // 12 min between calls
const RECENT_CHAT_TAIL = 6;
const SCENARIO_TAIL = 12;

let _attached = null;
let _piCallTimes = [];
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

	// Start the periodic Pi-coach drain loop.
	if (ctx.askPi && !_coachTimer) {
		_coachTimer = setInterval(() => {
			drainOnce({ askPi: ctx.askPi, stateDir: ctx.stateDir }).catch((e) =>
				warn("coach", `drain error: ${e?.message ?? e}`),
			);
		}, COACH_INTERVAL_MS);
		_coachTimer.unref?.();
		info("coach", `attached; drain every ${COACH_INTERVAL_MS / 1000}s`);
	} else {
		info("coach", "attached; Pi not provided, deaths captured without postmortem analysis");
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
export async function drainOnce({ askPi, stateDir, force = false } = {}) {
	if (!knowledgeAvailable()) return { ok: false, reason: "knowledge unavailable" };
	if (!askPi) return { ok: false, reason: "no askPi" };

	const now = Date.now();
	const hourAgo = now - 60 * 60 * 1000;
	_piCallTimes = _piCallTimes.filter((t) => t > hourAgo);
	if (!force && _piCallTimes.length >= COACH_PI_BUDGET_PER_HOUR) {
		return { ok: false, reason: "hourly budget exhausted", calls: _piCallTimes.length };
	}
	if (!force && _piCallTimes.length > 0 && now - _piCallTimes[_piCallTimes.length - 1] < COACH_COOLDOWN_MS) {
		return { ok: false, reason: "cooldown" };
	}

	const pending = unanalysedDeaths({ limit: COACH_BATCH_MAX });
	if (pending.length === 0) return { ok: true, analysed: 0 };

	const prompt = buildPrompt(pending);
	_piCallTimes.push(now);

	const reply = await askPiOnce({ askPi, prompt });
	if (!reply) return { ok: false, reason: "no reply" };

	const parsed = extractJson(reply);
	if (!parsed) {
		warn("coach", "Pi reply was not parseable JSON");
		return { ok: false, reason: "bad reply" };
	}

	let lessonsCount = 0;
	for (const item of asArray(parsed.lessons ?? parsed)) {
		if (!item || !item.lesson) continue;
		recordLesson({
			text: item.lesson,
			category: item.category ?? "survival",
			triggerSkill: item.trigger_skill ?? null,
			triggerHostile: item.trigger_hostile ?? null,
			triggerSituation: item.trigger_situation ?? null,
			avoidSkill: item.avoid_skill ?? null,
			preferSkill: item.prefer_skill ?? null,
			confidence: clamp(Number(item.confidence) || 0.6, 0.1, 0.95),
			source: "pi-coach",
			sourceRef: item.source_ref ?? null,
		});
		lessonsCount += 1;
	}

	// Write one postmortem per death; if Pi grouped them, share the same lesson.
	const groupLesson = parsed.lessons?.[0]?.lesson ?? parsed.lesson ?? null;
	for (const d of pending) {
		insertPostmortem({
			deathId: d.id,
			cause: parsed.cause ?? d.cause,
			lesson: groupLesson,
			nextAction: parsed.next_action ?? null,
			rawResponse: reply.slice(0, 4000),
			source: "pi",
		});
		markDeathAnalysed(d.id);
	}

	info("coach", `drain: analysed ${pending.length} deaths → ${lessonsCount} lessons`);
	return { ok: true, analysed: pending.length, lessons: lessonsCount };
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

	return [
		"You are reviewing recent deaths of an autonomous Minecraft survival bot (pepa).",
		"The bot is trying to gather wood, craft tools, build a small village, and survive nights.",
		"It's currently dying repeatedly. Your job: extract 1-3 short, generalised lessons it can apply on respawn.",
		"",
		"DEATHS:",
		summary,
		"",
		"Reply with ONE JSON object (no prose, no markdown fences):",
		'{ "cause": "<short>", "next_action": "<one-sentence directive>",',
		'  "lessons": [',
		'    { "lesson": "...", "category": "combat|pathing|crafting|survival|social",',
		'      "trigger_skill": "<skill id or null>",',
		'      "trigger_hostile": "<mob name or null>",',
		'      "avoid_skill": "<skill to NOT dispatch or null>",',
		'      "prefer_skill": "<alternative skill or null>",',
		'      "confidence": 0.7 }',
		'  ] }',
		"",
		"Keep each lesson under 30 words. Be specific (e.g., \"attack creeper with fists\" rather than \"don't fight\").",
	].join("\n");
}

function askPiOnce({ askPi, prompt }) {
	return new Promise((resolve) => {
		let buf = "";
		try {
			askPi({
				prompt,
				onChunk: ({ stream, text }) => {
					if (stream === "stdout") buf += text;
				},
				onDone: () => resolve(buf),
			});
		} catch (e) {
			warn("coach", `askPi failed: ${e?.message ?? e}`);
			resolve(null);
		}
	});
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
export const __testing = { captureDeath, buildPrompt, extractJson, inferCause };
