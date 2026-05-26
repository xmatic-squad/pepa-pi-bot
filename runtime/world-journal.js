// Persistent map of what the bot has discovered in the world. Append-only
// JSONL at state/<host>/world-journal.jsonl. Lines look like:
//
//   {"ts":"…","kind":"tree","name":"oak_log","at":{"x":..,"y":..,"z":..},"dim":"overworld"}
//   {"ts":"…","kind":"stone","name":"stone","at":{...}}
//   {"ts":"…","kind":"water","at":{...}}
//   {"ts":"…","kind":"sheep","at":{...}}
//   {"ts":"…","kind":"hostile_zone","name":"zombie","at":{...},"count":12}
//   {"ts":"…","kind":"dead_end","reason":"wedged","at":{...}}
//   {"ts":"…","kind":"chopped","name":"oak_log","at":{...}}     // we removed this block
//   {"ts":"…","kind":"placed","name":"crafting_table","at":{...}}
//
// On boot we replay the file into an in-memory index (kind → spatial
// bucket). Bucket = floor(coord / GRID_CELL) so lookups are O(neighbors).
// Old entries auto-prune at MAX_AGE_MS so the bot adapts to changing world.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./config.js";

const JOURNAL_PATH = path.join(stateDir, "world-journal.jsonl");
const GRID_CELL = 16;
const MAX_AGE_MS = 6 * 60 * 60_000; // 6 hours; world changes faster than that on a live server
const MAX_LINES = 10_000;
const TRIM_TARGET = 7_500;

function ensureDir() {
	try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
}

function cellOf(x, z) {
	return `${Math.floor(x / GRID_CELL)},${Math.floor(z / GRID_CELL)}`;
}

function loadJournal() {
	const index = new Map(); // "kind:cell" → array of entries
	let raw = "";
	try { raw = fs.readFileSync(JOURNAL_PATH, "utf8"); }
	catch (e) { if (e.code !== "ENOENT") return { index }; return { index }; }
	const now = Date.now();
	const lines = raw.split("\n").filter((l) => l.trim());
	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (!entry?.at || typeof entry.at.x !== "number") continue;
			const ts = Date.parse(entry.ts ?? "");
			if (Number.isFinite(ts) && now - ts > MAX_AGE_MS) continue;
			const key = `${entry.kind}:${cellOf(entry.at.x, entry.at.z)}`;
			const bucket = index.get(key) ?? [];
			bucket.push(entry);
			index.set(key, bucket);
		} catch {}
	}
	return { index, count: lines.length };
}

function maybeTrim(count) {
	if (count <= MAX_LINES) return;
	try {
		const raw = fs.readFileSync(JOURNAL_PATH, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim());
		const keep = lines.slice(-TRIM_TARGET).join("\n") + "\n";
		const tmp = `${JOURNAL_PATH}.tmp`;
		fs.writeFileSync(tmp, keep);
		fs.renameSync(tmp, JOURNAL_PATH);
	} catch {}
}

export function createWorldJournal() {
	let { index, count = 0 } = loadJournal();
	let appended = count;

	function append(entry) {
		if (!entry?.kind || !entry?.at) return;
		ensureDir();
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
		fs.appendFileSync(JOURNAL_PATH, line);
		const key = `${entry.kind}:${cellOf(entry.at.x, entry.at.z)}`;
		const bucket = index.get(key) ?? [];
		bucket.push({ ts: new Date().toISOString(), ...entry });
		index.set(key, bucket);
		appended++;
		if (appended % 500 === 0) maybeTrim(appended);
	}

	// O(neighbors): scan a ring of cells around (x,z) up to `radius` blocks
	// and return all entries matching `kind`. Filters out dead_end markers
	// older than the live game cycle.
	function nearest({ kind, x, z, radius = 32, limit = 5 }) {
		const cellsPerSide = Math.ceil(radius / GRID_CELL);
		const cx = Math.floor(x / GRID_CELL);
		const cz = Math.floor(z / GRID_CELL);
		const out = [];
		for (let dx = -cellsPerSide; dx <= cellsPerSide; dx++) {
			for (let dz = -cellsPerSide; dz <= cellsPerSide; dz++) {
				const key = `${kind}:${cx + dx},${cz + dz}`;
				const bucket = index.get(key);
				if (!bucket) continue;
				for (const e of bucket) {
					const d = Math.hypot(e.at.x - x, e.at.z - z);
					if (d <= radius) out.push({ ...e, distance: d });
				}
			}
		}
		out.sort((a, b) => a.distance - b.distance);
		return out.slice(0, limit);
	}

	// "Which quadrants have we NOT searched yet?" — exploration helper for
	// explore.far. Counts dead_end + dead-target entries per quadrant, recommends
	// the leanest one.
	function leanestQuadrant({ x, z, radius = 64 }) {
		const quads = {
			NE: 0, SE: 0, SW: 0, NW: 0,
		};
		for (const bucket of index.values()) {
			for (const e of bucket) {
				const dx = e.at.x - x;
				const dz = e.at.z - z;
				if (Math.hypot(dx, dz) > radius) continue;
				if (dx >= 0 && dz < 0) quads.NE++;
				else if (dx >= 0 && dz >= 0) quads.SE++;
				else if (dx < 0 && dz >= 0) quads.SW++;
				else quads.NW++;
			}
		}
		// Return the quadrant with the FEWEST known markers — least explored.
		let best = "NE";
		for (const [q, c] of Object.entries(quads)) if (c < quads[best]) best = q;
		return { best, counts: quads };
	}

	function summary() {
		const byKind = {};
		for (const [key, bucket] of index) {
			const kind = key.split(":")[0];
			byKind[kind] = (byKind[kind] ?? 0) + bucket.length;
		}
		return { totalBuckets: index.size, byKind };
	}

	function clear() {
		index.clear();
		try { fs.unlinkSync(JOURNAL_PATH); } catch {}
		appended = 0;
	}

	return { append, nearest, leanestQuadrant, summary, clear };
}

export const _internal = { cellOf, GRID_CELL, MAX_AGE_MS };
