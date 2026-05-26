// Named locations persisted under state/<host>/locations.json. The bot
// records places it cares about: "base", "wood-spot", "stone-spot",
// "wheat-farm", "chest-1". The format is a flat dict keyed by name; the
// value carries the integer block coordinates, an optional radius (for
// "the wood-spot is somewhere in this 16-block square"), the dimension
// and a free-form note for diary readability.
//
// All writes are sync — the file is small (a few dozen entries at most).
// We write atomically (tmp + rename) so a crash mid-write doesn't leave
// a half-written JSON.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./config.js";

const LOCATIONS_PATH = path.join(stateDir, "locations.json");

function ensureDir() {
	try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
}

function loadAll() {
	try {
		const raw = fs.readFileSync(LOCATIONS_PATH, "utf8").trim();
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (e) {
		if (e.code === "ENOENT") return {};
		return {};
	}
}

function saveAll(map) {
	ensureDir();
	const tmp = `${LOCATIONS_PATH}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
	fs.renameSync(tmp, LOCATIONS_PATH);
}

export function listLocations() {
	return loadAll();
}

export function getLocation(name) {
	const all = loadAll();
	return all[name] ?? null;
}

export function setLocation(name, {
	x, y, z,
	dimension = "overworld",
	radius = 0,
	note = "",
}) {
	if (!name) throw new Error("setLocation: name required");
	if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
		throw new Error("setLocation: x/y/z must be numbers");
	}
	const all = loadAll();
	all[name] = {
		x: Math.round(x),
		y: Math.round(y),
		z: Math.round(z),
		dimension,
		radius,
		note,
		ts: new Date().toISOString(),
	};
	saveAll(all);
	return all[name];
}

export function removeLocation(name) {
	const all = loadAll();
	if (!(name in all)) return false;
	delete all[name];
	saveAll(all);
	return true;
}

// Find the named location closest to (x,y,z) — useful for "go back to
// base" when there are multiple shelters.
export function nearestLocation({ x, z }) {
	const all = loadAll();
	let best = null;
	for (const [name, loc] of Object.entries(all)) {
		if (typeof loc?.x !== "number") continue;
		const d = Math.hypot(loc.x - x, loc.z - z);
		if (!best || d < best.d) best = { name, loc, d };
	}
	return best;
}
