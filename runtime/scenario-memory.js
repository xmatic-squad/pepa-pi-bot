// Scenario memory: the bot remembers what skill it tried in what kind of
// situation and how that worked out. Two consumers:
//
//   1. The scheduler skips a skill when (skillId, situationHash) showed
//      ≥N failures within MEMORY_WINDOW_MS — no point retrying the same
//      thing in the same context. The cooldown is shorter than the
//      per-skill backoff so the bot can come back later, but the hash
//      includes the current biome + time-of-day + nearby-block-types so
//      "I'm in a different place now" un-locks the skill automatically.
//
//   2. Pi-side proposals (stuck-incident) get a tail of recent entries
//      so the LLM can see what's been tried and reason about it
//      structurally instead of guessing.
//
// Persisted at state/<host>/scenarios.jsonl, append-only. Loaded into a
// circular in-memory buffer for fast lookups. Old entries pruned by age.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./config.js";

const SCENARIO_PATH = path.join(stateDir, "scenarios.jsonl");
const MAX_LINES = 5_000;
const TRIM_TARGET = 3_500;
const MEMORY_WINDOW_MS = 30 * 60_000; // 30 min — recent enough to matter

function ensureDir() {
	try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
}

// Cheap structural hash of the situation the bot is acting in: bucketed
// position (16×16×8 cell), biome (if known), day/night, food bucket,
// inventory keys (presence only, not counts), closest hostile type. The
// hash is intentionally coarse — we want "same kind of place + same kind
// of state" to match, not "exact (x,y,z) again".
export function situationHash(snapshot) {
	if (!snapshot?.connected) return "disconnected";
	const p = snapshot.position ?? { x: 0, y: 0, z: 0 };
	const cx = Math.floor(p.x / 16);
	const cy = Math.floor(p.y / 8);
	const cz = Math.floor(p.z / 16);
	const day = snapshot.isDay ? "d" : "n";
	const food = snapshot.food === undefined ? "?" : snapshot.food >= 18 ? "F" : snapshot.food >= 12 ? "f" : "h";
	const hp = (snapshot.health ?? 20) >= 15 ? "H" : "L";
	const hostile = snapshot.closestHostile && snapshot.closestHostile.distance < 24
		? snapshot.closestHostile.name
		: "-";
	const biome = snapshot.biome ?? "-";
	const blocks = Object.keys(snapshot.nearbyBlocks ?? {})
		.sort()
		.slice(0, 8)
		.join(",") || "-";
	// Inventory keys, sorted — we lose counts but keep "what kind of stuff do
	// I have". Limited to first 10 names for hash stability.
	const invKeys = Object.keys(snapshot.inventory ?? {})
		.sort()
		.slice(0, 10)
		.join(",") || "-";
	return `${cx},${cy},${cz}|${day}|${food}|${hp}|bio:${biome}|blocks:${blocks}|host:${hostile}|inv:${invKeys}`;
}

function loadScenarios() {
	const entries = [];
	let raw = "";
	try { raw = fs.readFileSync(SCENARIO_PATH, "utf8"); }
	catch (e) { if (e.code !== "ENOENT") return entries; return entries; }
	const now = Date.now();
	const lines = raw.split("\n").filter((l) => l.trim());
	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			const ts = Date.parse(entry.ts ?? "");
			if (!Number.isFinite(ts)) continue;
			if (now - ts > MEMORY_WINDOW_MS * 4) continue; // hard expire ×4 window
			entries.push({ ...entry, _ts: ts });
		} catch {}
	}
	return entries;
}

function maybeTrim(linesSoFar) {
	if (linesSoFar <= MAX_LINES) return;
	try {
		const raw = fs.readFileSync(SCENARIO_PATH, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim());
		const keep = lines.slice(-TRIM_TARGET).join("\n") + "\n";
		const tmp = `${SCENARIO_PATH}.tmp`;
		fs.writeFileSync(tmp, keep);
		fs.renameSync(tmp, SCENARIO_PATH);
	} catch {}
}

export function createScenarioMemory({ failureThreshold = 3, windowMs = MEMORY_WINDOW_MS } = {}) {
	const entries = loadScenarios();
	let appended = entries.length;

	function record({ skillId, situation, code, ok, detail }) {
		if (!skillId || !situation) return;
		const entry = {
			ts: new Date().toISOString(),
			skillId, situation, code, ok: !!ok,
			detail: detail ? String(detail).slice(0, 200) : null,
			_ts: Date.now(),
		};
		entries.push(entry);
		ensureDir();
		fs.appendFileSync(SCENARIO_PATH, JSON.stringify({ ...entry, _ts: undefined }) + "\n");
		appended++;
		if (appended % 200 === 0) maybeTrim(appended);
	}

	function recentFailures({ skillId, situation, now = Date.now() }) {
		return entries.filter((e) =>
			e.skillId === skillId &&
			e.situation === situation &&
			!e.ok &&
			now - e._ts < windowMs
		);
	}

	// Decision: "should I skip dispatching skill in this situation right now?"
	function shouldSkip({ skillId, situation, now = Date.now() }) {
		const fails = recentFailures({ skillId, situation, now });
		if (fails.length < failureThreshold) return false;
		// Also: have we succeeded with this same (skill, situation) lately? If
		// so, don't skip — the pattern may have changed.
		const recentOk = entries.find((e) =>
			e.skillId === skillId &&
			e.situation === situation &&
			e.ok &&
			now - e._ts < windowMs,
		);
		if (recentOk) return false;
		return true;
	}

	// Pi-bound: tail of recent attempts as plain text (skill, situation, code, ok).
	function recentTailFor({ skillId, n = 10 } = {}) {
		const filtered = skillId ? entries.filter((e) => e.skillId === skillId) : entries;
		return filtered.slice(-n).map((e) => ({
			ts: e.ts,
			skillId: e.skillId,
			ok: e.ok,
			code: e.code,
			detail: e.detail,
			situationHashShort: (e.situation ?? "").slice(0, 60),
		}));
	}

	function size() { return entries.length; }
	function clear() { entries.length = 0; try { fs.unlinkSync(SCENARIO_PATH); } catch {} }

	return { record, recentFailures, shouldSkip, recentTailFor, size, clear };
}
