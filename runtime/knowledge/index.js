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

function safeParse(s) {
	if (!s) return null;
	try { return JSON.parse(s); } catch { return null; }
}
