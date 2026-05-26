// village.build-shelter — place a minimal 3×3×3 hut around the bot's
// recorded base (or current position if no base yet). The blueprint is
// computed once per call as a list of {x,y,z,blockType} targets, then
// the skill places them in order, marking each placed block in the
// owned-blocks ledger. Idempotent: any target that already holds the
// right block is skipped, so the skill is resumable across restarts.
//
// Walls use any *_planks the bot carries (we pick the most-common type).
// The interior keeps the bed slot empty (assumes the bed sits on
// (cx+1, cy, cz) — i.e. one step east of the centre).
//
// Out of scope here: door entity (mineflayer can't reliably place doors
// without recent version checks). The west wall has a 1-block opening
// at head-height the bot can step through.

import { applyProfile, PROFILES } from "../movement-profiles.js";
import { info, warn } from "../log.js";
import { getLocation, setLocation } from "../locations.js";

const SHELTER_NAME = "shelter";

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function pickBuildPlanks(bot) {
	const counts = new Map();
	for (const item of bot.inventory.items()) {
		if (item.name.endsWith("_planks")) {
			counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
		}
	}
	let best = null;
	for (const [name, n] of counts) {
		if (!best || n > best.n) best = { name, n };
	}
	return best;
}

// Build a list of {x,y,z, name} targets for a 3×3 footprint × 3-tall
// shelter centred on (cx, cy, cz). Bed slot (cx+1, cy, cz) and head-
// height entry at the west wall (cx-1, cy+1, cz) are left empty.
function blueprint(center, plankName) {
	const targets = [];
	const { x: cx, y: cy, z: cz } = center;
	// Floor: only the corners we don't already have (skip the bed slot).
	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			targets.push({ x: cx + dx, y: cy - 1, z: cz + dz, name: plankName });
		}
	}
	// Walls (y = cy and y = cy+1).
	for (let dy = 0; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				const isCorner = Math.abs(dx) + Math.abs(dz) === 2;
				const isWall = Math.abs(dx) === 1 || Math.abs(dz) === 1;
				if (!isWall && !isCorner) continue; // skip interior column
				// Leave one wall slot open as a doorway: west wall, head height.
				if (dx === -1 && dz === 0 && dy === 1) continue;
				// Bed occupies (cx+1, cy, cz) — its second half is at (cx+2, cy, cz)
				// which is OUTSIDE this 3×3 footprint. So we don't need to clear it.
				targets.push({ x: cx + dx, y: cy + dy, z: cz + dz, name: plankName });
			}
		}
	}
	// Roof: full 3×3 at y = cy+2.
	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			targets.push({ x: cx + dx, y: cy + 2, z: cz + dz, name: plankName });
		}
	}
	return targets;
}

function blockMatchesName(block, name) {
	return block && block.name === name;
}

function findReferenceForPlacement(bot, target) {
	// Try the block below the target first (most natural place to stack
	// from). If it's air, try sides.
	const offsets = [
		{ x: 0, y: -1, z: 0, face: { x: 0, y: 1, z: 0 } },
		{ x: -1, y: 0, z: 0, face: { x: 1, y: 0, z: 0 } },
		{ x: 1, y: 0, z: 0, face: { x: -1, y: 0, z: 0 } },
		{ x: 0, y: 0, z: -1, face: { x: 0, y: 0, z: 1 } },
		{ x: 0, y: 0, z: 1, face: { x: 0, y: 0, z: -1 } },
		{ x: 0, y: 1, z: 0, face: { x: 0, y: -1, z: 0 } },
	];
	for (const off of offsets) {
		const block = bot.blockAt({
			x: target.x + off.x,
			y: target.y + off.y,
			z: target.z + off.z,
		});
		if (block && block.boundingBox === "block") return { ref: block, face: off.face };
	}
	return null;
}

export const skill = Object.freeze({
	id: "village.build-shelter",
	title: "Build a tiny shelter around the bed",
	timeoutMs: 5 * 60_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const planks = pickBuildPlanks(ctx.bot);
		if (!planks || planks.n < 18) {
			return { ok: false, code: "missing_material", detail: `need ≥18 planks (have ${planks?.n ?? 0})` };
		}
		// Need a base or at least a placed bed nearby; the chooseBase skill
		// is responsible for picking the spot first.
		const base = getLocation("base") ?? getLocation(SHELTER_NAME);
		if (!base) return { ok: false, code: "no_base", detail: "no base location chosen yet" };
		return { ok: true };
	},
	async execute(ctx, { owned } = {}) {
		const bot = ctx.bot;
		const planks = pickBuildPlanks(bot);
		const base = getLocation("base") ?? getLocation(SHELTER_NAME);
		const center = { x: base.x, y: base.y, z: base.z };

		applyProfile(PROFILES.BUILD, bot);

		const targets = blueprint(center, planks.name);
		info("action", `village.build-shelter: ${targets.length} blocks (planks=${planks.name})`);

		let placed = 0;
		let skipped = 0;
		for (const target of targets) {
			const existing = bot.blockAt(target);
			if (blockMatchesName(existing, planks.name)) {
				skipped++;
				continue;
			}
			// Re-equip planks each iteration (the bot might have eaten / swapped).
			const item = bot.inventory.items().find((i) => i.name === planks.name);
			if (!item) {
				warn("action", `village.build-shelter: ran out of ${planks.name} mid-build`);
				break;
			}
			try {
				await withTimeout(bot.equip(item, "hand"), 3000, "equip plank");
			} catch (e) {
				warn("action", `village.build-shelter: equip failed: ${e.message}`);
				continue;
			}

			const place = findReferenceForPlacement(bot, target);
			if (!place) {
				warn("action", `village.build-shelter: no reference block for ${target.x},${target.y},${target.z}`);
				continue;
			}
			try {
				await withTimeout(bot.placeBlock(place.ref, place.face), 5000, "placeBlock");
				if (owned?.markPlaced) {
					owned.markPlaced({
						x: target.x, y: target.y, z: target.z,
						blockType: planks.name,
						skill: "village.build-shelter",
					});
				}
				placed++;
			} catch (e) {
				warn("action", `village.build-shelter: place ${target.x},${target.y},${target.z} failed: ${e.message}`);
			}
		}

		// Record the shelter location so future skills can find it even if
		// base gets re-scored.
		setLocation(SHELTER_NAME, { x: center.x, y: center.y, z: center.z, radius: 2, note: `auto-built; ${placed} blocks placed` });

		if (placed === 0 && skipped === 0) {
			return { ok: false, code: "no_progress", detail: "could not place any blocks", worldDelta: null };
		}
		return {
			ok: true,
			code: "done",
			detail: { placed, skipped, total: targets.length, plankName: planks.name },
			worldDelta: { shelterAt: center, placed },
		};
	},
});
