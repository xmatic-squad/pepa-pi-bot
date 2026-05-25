// Owned-blocks ledger. The bot places blocks (crafting table, chest,
// torch, shelter walls). When it later considers mining something or
// the claim-avoidance heuristic asks "is this a player build?", it
// needs to recognise its own work and not treat it as someone else's.
//
// Stored under state/<host>/owned-blocks.jsonl as a streaming append-
// only log keyed by "x,y,z@dimension". On boot we load it into a Set
// for O(1) lookups. The file is small enough (a few hundred entries
// for a village) that we don't bother compacting.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./config.js";

const LEDGER_PATH = path.join(stateDir, "owned-blocks.jsonl");

// Make sure the parent directory exists. Cheap to repeat — fs.mkdirSync
// with recursive:true is idempotent — and avoids ENOENT in tests that
// start from a fresh tmp dir.
function ensureDir() {
	try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
}

function keyOf(x, y, z, dimension = "overworld") {
	return `${Math.round(x)},${Math.round(y)},${Math.round(z)}@${dimension}`;
}

function loadLedger() {
	const set = new Set();
	try {
		const raw = fs.readFileSync(LEDGER_PATH, "utf8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const entry = JSON.parse(trimmed);
				if (entry.action === "place") set.add(keyOf(entry.x, entry.y, entry.z, entry.dimension));
				else if (entry.action === "remove") set.delete(keyOf(entry.x, entry.y, entry.z, entry.dimension));
			} catch {
				// skip malformed line
			}
		}
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return set;
}

export function createOwnedBlocksLedger() {
	const owned = loadLedger();

	function append(action, entry) {
		ensureDir();
		const line = JSON.stringify({ ts: new Date().toISOString(), action, ...entry }) + "\n";
		fs.appendFileSync(LEDGER_PATH, line);
	}

	function markPlaced({ x, y, z, dimension = "overworld", blockType = null, skill = null }) {
		const k = keyOf(x, y, z, dimension);
		if (owned.has(k)) return;
		owned.add(k);
		append("place", { x: Math.round(x), y: Math.round(y), z: Math.round(z), dimension, blockType, skill });
	}

	function markRemoved({ x, y, z, dimension = "overworld" }) {
		const k = keyOf(x, y, z, dimension);
		if (!owned.has(k)) return;
		owned.delete(k);
		append("remove", { x: Math.round(x), y: Math.round(y), z: Math.round(z), dimension });
	}

	function isOwned({ x, y, z, dimension = "overworld" }) {
		return owned.has(keyOf(x, y, z, dimension));
	}

	function size() {
		return owned.size;
	}

	function snapshot() {
		return new Set(owned);
	}

	return { markPlaced, markRemoved, isOwned, size, snapshot };
}
