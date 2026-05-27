// Public surface of the knowledge subsystem. Other runtime modules should
// import from here, not from store/seed/lessons directly.
//
// Wire-up:
//   await initKnowledge({ stateDir })
//     - opens the SQLite DB at state/<host>/knowledge.db
//     - applies schema
//     - seeds starter recipes/mobs/blocks/lessons (idempotent)
//   isAvailable() — true once init succeeded
//
// All other helpers degrade gracefully when the store is unavailable
// (e.g. fresh checkout without `npm install`).

export { isAvailable, disabledReason, getStore, closeStore, runMaintenance } from "./store.js";
export { recall, record, markApplied, topAdvice } from "./lessons.js";

import { ensureStore, isAvailable as _isAvailable } from "./store.js";
import { seed } from "./seed.js";
import { warn, info } from "../log.js";

let _initialised = false;

export async function initKnowledge({ stateDir } = {}) {
	if (_initialised) return _isAvailable();
	_initialised = true;
	const db = await ensureStore({ stateDir });
	if (!db) {
		warn("knowledge", "init: store not available; knowledge layer will be a no-op");
		return false;
	}
	const seedResult = seed();
	if (!seedResult.ok) {
		warn("knowledge", `init: seed step failed (${seedResult.reason})`);
	}
	return true;
}

// Death/postmortem helpers — separate file would be overkill; they share
// the store and are only called from coach/postmortem.js.
import { getStore as _getStore } from "./store.js";

export function insertDeath({ ts, x, y, z, cause, hostile, lastSkill, lastSkillCode,
	hp, food, inventoryLost, contextBlob } = {}) {
	if (!_isAvailable()) return null;
	try {
		const stmt = _getStore().prepare(`
			INSERT INTO deaths (ts, x, y, z, cause, hostile, last_skill, last_skill_code,
			                    hp_at_death, food_at_death, inventory_lost, context_blob, analysed)
			VALUES (@ts, @x, @y, @z, @cause, @hostile, @lastSkill, @lastSkillCode,
			        @hp, @food, @inventoryLost, @contextBlob, 0)
		`);
		const res = stmt.run({
			ts: ts ?? Date.now(),
			x: x ?? null, y: y ?? null, z: z ?? null,
			cause: cause ?? "unknown",
			hostile: hostile ?? null,
			lastSkill: lastSkill ?? null,
			lastSkillCode: lastSkillCode ?? null,
			hp: hp ?? null,
			food: food ?? null,
			inventoryLost: inventoryLost ? JSON.stringify(inventoryLost) : null,
			contextBlob: contextBlob ? JSON.stringify(contextBlob) : null,
		});
		return res.lastInsertRowid;
	} catch (e) {
		warn("knowledge", `insertDeath failed: ${e?.message ?? e}`);
		return null;
	}
}

export function unanalysedDeaths({ limit = 5 } = {}) {
	if (!_isAvailable()) return [];
	try {
		return _getStore().prepare(`
			SELECT * FROM deaths WHERE analysed = 0 ORDER BY ts ASC LIMIT @limit
		`).all({ limit });
	} catch (e) {
		warn("knowledge", `unanalysedDeaths failed: ${e?.message ?? e}`);
		return [];
	}
}

export function markDeathAnalysed(deathId) {
	if (!_isAvailable()) return;
	try {
		_getStore().prepare("UPDATE deaths SET analysed = 1 WHERE id = ?").run(deathId);
	} catch (e) {
		warn("knowledge", `markDeathAnalysed failed: ${e?.message ?? e}`);
	}
}

export function insertPostmortem({ deathId, cause, lesson, nextAction, rawResponse, source = "pi" } = {}) {
	if (!_isAvailable() || !deathId) return null;
	try {
		const res = _getStore().prepare(`
			INSERT INTO postmortems (death_id, ts, cause, lesson, next_action, raw_response, source)
			VALUES (@deathId, @ts, @cause, @lesson, @nextAction, @rawResponse, @source)
		`).run({
			deathId,
			ts: Date.now(),
			cause: cause ?? null,
			lesson: lesson ?? null,
			nextAction: nextAction ?? null,
			rawResponse: rawResponse ?? null,
			source,
		});
		return res.lastInsertRowid;
	} catch (e) {
		warn("knowledge", `insertPostmortem failed: ${e?.message ?? e}`);
		return null;
	}
}

// Recipe / mob / block lookups
export function lookupRecipe(name) {
	if (!_isAvailable()) return null;
	try {
		const row = _getStore().prepare(`SELECT * FROM recipes WHERE name = ?`).get(name);
		if (!row) return null;
		return { ...row, shape: safeParse(row.shape) };
	} catch (e) {
		warn("knowledge", `lookupRecipe failed: ${e?.message ?? e}`);
		return null;
	}
}

export function lookupMob(name) {
	if (!_isAvailable() || !name) return null;
	try {
		const row = _getStore().prepare(`SELECT * FROM mob_intel WHERE name = ?`).get(name);
		if (!row) return null;
		return { ...row, drops: safeParse(row.drops) };
	} catch (e) {
		warn("knowledge", `lookupMob failed: ${e?.message ?? e}`);
		return null;
	}
}

export function lookupBlock(name) {
	if (!_isAvailable() || !name) return null;
	try {
		const row = _getStore().prepare(`SELECT * FROM block_intel WHERE name = ?`).get(name);
		if (!row) return null;
		return { ...row, drops: safeParse(row.drops) };
	} catch (e) {
		warn("knowledge", `lookupBlock failed: ${e?.message ?? e}`);
		return null;
	}
}

// POI helpers — spatially-keyed long-term memory.
const CELL = 16;

export function recordPOI({ kind, name, x, y, z, expiresAt, notes } = {}) {
	if (!_isAvailable() || typeof x !== "number" || typeof z !== "number") return null;
	try {
		const stmt = _getStore().prepare(`
			INSERT INTO poi (kind, name, x, y, z, cell_x, cell_z, ts, expires_at, notes)
			VALUES (@kind, @name, @x, @y, @z, @cellX, @cellZ, @ts, @expiresAt, @notes)
		`);
		const cellX = Math.floor(x / CELL);
		const cellZ = Math.floor(z / CELL);
		const res = stmt.run({
			kind, name: name ?? null,
			x, y: y ?? 0, z,
			cellX, cellZ,
			ts: Date.now(),
			expiresAt: expiresAt ?? null,
			notes: notes ?? null,
		});
		return res.lastInsertRowid;
	} catch (e) {
		warn("knowledge", `recordPOI failed: ${e?.message ?? e}`);
		return null;
	}
}

export function poiNearby({ x, z, kind, radius = 64, limit = 8 } = {}) {
	if (!_isAvailable() || typeof x !== "number" || typeof z !== "number") return [];
	try {
		const cellX = Math.floor(x / CELL);
		const cellZ = Math.floor(z / CELL);
		const cellRadius = Math.ceil(radius / CELL);
		const sql = `
			SELECT *, ((x - @x) * (x - @x) + (z - @z) * (z - @z)) AS dist2
			FROM poi
			WHERE cell_x BETWEEN @cxLo AND @cxHi
			  AND cell_z BETWEEN @czLo AND @czHi
			  ${kind ? "AND kind = @kind" : ""}
			  AND (expires_at IS NULL OR expires_at > @now)
			ORDER BY dist2 ASC
			LIMIT @limit
		`;
		return _getStore().prepare(sql).all({
			x, z,
			cxLo: cellX - cellRadius, cxHi: cellX + cellRadius,
			czLo: cellZ - cellRadius, czHi: cellZ + cellRadius,
			kind: kind ?? null,
			now: Date.now(),
			limit,
		}).filter((r) => r.dist2 <= radius * radius);
	} catch (e) {
		warn("knowledge", `poiNearby failed: ${e?.message ?? e}`);
		return [];
	}
}

// Chat log
export function logChat({ direction, speaker, text, intent, repliedWith } = {}) {
	if (!_isAvailable() || !text) return null;
	try {
		const res = _getStore().prepare(`
			INSERT INTO chat_log (ts, direction, speaker, text, intent, replied_with)
			VALUES (@ts, @direction, @speaker, @text, @intent, @repliedWith)
		`).run({
			ts: Date.now(),
			direction: direction ?? "in",
			speaker: speaker ?? null,
			text,
			intent: intent ?? null,
			repliedWith: repliedWith ?? null,
		});
		return res.lastInsertRowid;
	} catch (e) {
		warn("knowledge", `logChat failed: ${e?.message ?? e}`);
		return null;
	}
}

// ---- v0.3.0 advisor recommendations ----------------------------------------
//
// Every fast-advisor call that produced a usable answer is logged here.
// Rows are mutated post-hoc when reflex applies and when the dispatch
// finishes — this is the ground truth for "is the LLM advice actually
// helping" and the input to trigger-tuner.js.

export function insertRecommendation({
	triggerReason, plannedSkill, recommendedSkill, action, rationale,
	activeNeed, tokensIn, tokensOut, latencyMs,
} = {}) {
	if (!_isAvailable()) return null;
	try {
		const res = _getStore().prepare(`
			INSERT INTO advisor_recommendations
			  (ts, trigger_reason, planned_skill, recommended_skill, action, rationale,
			   active_need, tokens_in, tokens_out, latency_ms, applied)
			VALUES
			  (@ts, @triggerReason, @plannedSkill, @recommendedSkill, @action, @rationale,
			   @activeNeed, @tokensIn, @tokensOut, @latencyMs, 0)
		`).run({
			ts: Date.now(),
			triggerReason,
			plannedSkill: plannedSkill ?? null,
			recommendedSkill: recommendedSkill ?? null,
			action,
			rationale: rationale ?? null,
			activeNeed: activeNeed ?? null,
			tokensIn: tokensIn ?? null,
			tokensOut: tokensOut ?? null,
			latencyMs: latencyMs ?? null,
		});
		return res.lastInsertRowid;
	} catch (e) {
		warn("knowledge", `insertRecommendation failed: ${e?.message ?? e}`);
		return null;
	}
}

export function markRecommendationApplied(id) {
	if (!_isAvailable() || !id) return;
	try {
		_getStore().prepare(`UPDATE advisor_recommendations SET applied = 1 WHERE id = ?`).run(id);
	} catch (e) {
		warn("knowledge", `markRecommendationApplied failed: ${e?.message ?? e}`);
	}
}

export function markRecommendationOutcome(id, { ok, code } = {}) {
	if (!_isAvailable() || !id) return;
	try {
		_getStore().prepare(`
			UPDATE advisor_recommendations
			SET outcome_ok = @ok, outcome_code = @code, outcome_at = @at
			WHERE id = @id
		`).run({ id, ok: ok ? 1 : 0, code: code ?? null, at: Date.now() });
	} catch (e) {
		warn("knowledge", `markRecommendationOutcome failed: ${e?.message ?? e}`);
	}
}

export function recommendationStats({ sinceHours = 24 } = {}) {
	if (!_isAvailable()) return [];
	try {
		const since = Date.now() - sinceHours * 3600_000;
		return _getStore().prepare(`
			SELECT trigger_reason,
			       COUNT(*) AS total,
			       SUM(applied) AS applied,
			       SUM(CASE WHEN outcome_ok = 1 THEN 1 ELSE 0 END) AS succeeded,
			       SUM(CASE WHEN outcome_ok = 0 THEN 1 ELSE 0 END) AS failed,
			       AVG(tokens_in) AS avg_in,
			       AVG(tokens_out) AS avg_out,
			       AVG(latency_ms) AS avg_latency_ms
			FROM advisor_recommendations
			WHERE ts >= @since
			GROUP BY trigger_reason
			ORDER BY total DESC
		`).all({ since });
	} catch (e) {
		warn("knowledge", `recommendationStats failed: ${e?.message ?? e}`);
		return [];
	}
}

export function recentRecommendations({ limit = 20 } = {}) {
	if (!_isAvailable()) return [];
	try {
		return _getStore().prepare(`
			SELECT * FROM advisor_recommendations ORDER BY ts DESC LIMIT @limit
		`).all({ limit });
	} catch (e) {
		warn("knowledge", `recentRecommendations failed: ${e?.message ?? e}`);
		return [];
	}
}

// ---- v0.3.0 improvement requests -------------------------------------------
//
// The LLM (postmortem / reflect / advisor) writes here when it sees the bot
// lack a needed skill or feature. Operator-readable via scripts/list-improvements.js.

export function createImprovementRequest({
	source, category, title, description, context, priority = 3,
} = {}) {
	if (!_isAvailable() || !title) return null;
	try {
		// Dedup: if an open request with same title (case-insensitive) exists,
		// bump its votes instead of inserting a new row.
		const dup = _getStore().prepare(`
			SELECT id, votes FROM improvement_requests
			WHERE LOWER(title) = LOWER(?) AND status = 'open'
			ORDER BY ts DESC LIMIT 1
		`).get(title);
		if (dup) {
			_getStore().prepare(`UPDATE improvement_requests SET votes = votes + 1 WHERE id = ?`).run(dup.id);
			return dup.id;
		}
		const res = _getStore().prepare(`
			INSERT INTO improvement_requests
			  (ts, source, category, title, description, context, priority, status, votes)
			VALUES
			  (@ts, @source, @category, @title, @description, @context, @priority, 'open', 1)
		`).run({
			ts: Date.now(),
			source: source ?? "manual",
			category: category ?? "other",
			title,
			description: description ?? null,
			context: context ? JSON.stringify(context) : null,
			priority: clamp(priority, 1, 5),
		});
		return res.lastInsertRowid;
	} catch (e) {
		warn("knowledge", `createImprovementRequest failed: ${e?.message ?? e}`);
		return null;
	}
}

export function listImprovements({ status, source, category, limit = 50 } = {}) {
	if (!_isAvailable()) return [];
	try {
		const where = [];
		const params = { limit };
		if (status) { where.push("status = @status"); params.status = status; }
		if (source) { where.push("source = @source"); params.source = source; }
		if (category) { where.push("category = @category"); params.category = category; }
		const sql = `
			SELECT * FROM improvement_requests
			${where.length ? "WHERE " + where.join(" AND ") : ""}
			ORDER BY (status = 'open') DESC, priority ASC, votes DESC, ts DESC
			LIMIT @limit
		`;
		return _getStore().prepare(sql).all(params).map((r) => ({
			...r,
			context: safeParse(r.context),
		}));
	} catch (e) {
		warn("knowledge", `listImprovements failed: ${e?.message ?? e}`);
		return [];
	}
}

export function markImprovementStatus(id, { status, notes } = {}) {
	if (!_isAvailable() || !id) return;
	const validStatuses = ["open", "in_progress", "implemented", "rejected", "duplicate"];
	if (!validStatuses.includes(status)) {
		warn("knowledge", `markImprovementStatus: invalid status "${status}"`);
		return;
	}
	try {
		const fields = ["status = @status", "notes = @notes"];
		const params = { id, status, notes: notes ?? null };
		if (status === "implemented") {
			fields.push("implemented_at = @implementedAt");
			params.implementedAt = Date.now();
		}
		_getStore().prepare(`UPDATE improvement_requests SET ${fields.join(", ")} WHERE id = @id`).run(params);
	} catch (e) {
		warn("knowledge", `markImprovementStatus failed: ${e?.message ?? e}`);
	}
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || lo)); }

function safeParse(s) {
	if (!s) return null;
	try { return JSON.parse(s); } catch { return null; }
}
