// Base-site scoring. Given a snapshot of nearby blocks + entities, score
// the bot's *current* position as a candidate base site. Higher is
// better. The scheduler can call this when curriculum reaches the
// "find a base" milestone — we deliberately don't scan the whole world
// from a tick; the bot scores wherever it currently stands.
//
// Score axes (all weighted equally so easy to tune):
//   * has wood within 16 blocks → +3 (we don't want to commute for trees)
//   * has stone within 12 blocks → +2
//   * has water within 24 blocks → +2
//   * surface is "flat-ish" (sample 5 y-values at radius 4, max-min ≤ 2) → +2
//   * no nearby player entities (>32 blocks to closest player) → +2
//   * no man-made blocks within 16 (claim-avoidance hit) → +3 (else -10)
//
// Returns { score, reasons: string[], position }.

import { isManMadeBlockName } from "./claim-avoidance.js";

const WOOD_RADIUS = 16;
const STONE_RADIUS = 12;
const WATER_RADIUS = 24;
const FLATNESS_RADIUS = 4;
const FLATNESS_TOLERANCE = 2;
const PLAYER_AVOID = 32;
const CLAIM_RADIUS = 16;

function isLogName(name) {
	return name && (name.endsWith("_log") || name.endsWith("_stem"));
}

function isStoneName(name) {
	return name === "stone" || name === "cobblestone" || name === "deepslate" || name === "andesite" || name === "diorite" || name === "granite";
}

function isWaterName(name) {
	return name === "water" || name === "kelp" || name === "seagrass" || name === "tall_seagrass";
}

// scoreSite — takes a fact bundle so it can be unit-tested without a bot.
// The bundle:
//   * blocks: Array<{ name, position: {x,y,z}, distance }>
//   * surfaceYs: Array<number> sampled around the bot's feet
//   * players: Array<{ distance }>  (excluding the bot itself)
//   * position: { x, y, z } — the candidate location
//   * isOwned: optional fn called for each man-made block; owned blocks
//     don't count toward the claim-avoidance penalty.
export function scoreSite({ blocks, surfaceYs, players, position, isOwned }) {
	const reasons = [];
	let score = 0;

	const hasWood = blocks.some((b) => isLogName(b.name) && (b.distance ?? Infinity) <= WOOD_RADIUS);
	if (hasWood) { score += 3; reasons.push("+3 wood nearby"); }
	else reasons.push("0 no wood within " + WOOD_RADIUS);

	const hasStone = blocks.some((b) => isStoneName(b.name) && (b.distance ?? Infinity) <= STONE_RADIUS);
	if (hasStone) { score += 2; reasons.push("+2 stone nearby"); }
	else reasons.push("0 no stone within " + STONE_RADIUS);

	const hasWater = blocks.some((b) => isWaterName(b.name) && (b.distance ?? Infinity) <= WATER_RADIUS);
	if (hasWater) { score += 2; reasons.push("+2 water nearby"); }
	else reasons.push("0 no water within " + WATER_RADIUS);

	if (Array.isArray(surfaceYs) && surfaceYs.length >= 5) {
		const min = Math.min(...surfaceYs);
		const max = Math.max(...surfaceYs);
		if (max - min <= FLATNESS_TOLERANCE) {
			score += 2; reasons.push("+2 surface is flat");
		} else {
			reasons.push(`0 surface bumpy (Δy=${max - min})`);
		}
	}

	const closestPlayer = (players ?? []).reduce(
		(min, p) => (p.distance < min ? p.distance : min),
		Infinity,
	);
	if (closestPlayer >= PLAYER_AVOID) {
		score += 2; reasons.push("+2 no players within " + PLAYER_AVOID);
	} else {
		reasons.push(`-0 player at ${Math.round(closestPlayer)}m (would shrink)`);
	}

	const claimBlocks = blocks.filter(
		(b) => isManMadeBlockName(b.name) && (b.distance ?? Infinity) <= CLAIM_RADIUS,
	);
	const claimNonOwned = claimBlocks.filter(
		(b) => !(typeof isOwned === "function" && b.position && isOwned(b.position)),
	);
	if (claimNonOwned.length === 0) {
		score += 3; reasons.push("+3 no foreign builds nearby");
	} else {
		score -= 10; reasons.push(`-10 foreign builds nearby (${claimNonOwned.length})`);
	}

	return { score, reasons, position };
}

// Score the bot's current position. Walks bot.findBlocks for cheap sets.
// Returns the same shape as scoreSite + the raw counts used.
export function scoreCurrentPosition(bot, { isOwned } = {}) {
	if (!bot?.entity?.position) return { score: -100, reasons: ["no bot position"], position: null };
	const pos = bot.entity.position;
	const here = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };

	// Sample blocks via findBlocks where available; degrade gracefully
	// when the registry is missing entries on older versions.
	function findOnce(predicate, maxDistance, count = 6) {
		try {
			const ids = [];
			const reg = bot.registry?.blocksByName ?? {};
			for (const name of Object.keys(reg)) if (predicate(name)) ids.push(reg[name].id);
			if (ids.length === 0) return [];
			const positions = bot.findBlocks({ matching: ids, maxDistance, count });
			return positions.map((p) => ({
				name: bot.blockAt(p)?.name ?? "?",
				position: { x: p.x, y: p.y, z: p.z },
				distance: Math.hypot(p.x - here.x, p.z - here.z),
			}));
		} catch {
			return [];
		}
	}

	const woods = findOnce(isLogName, WOOD_RADIUS);
	const stones = findOnce(isStoneName, STONE_RADIUS);
	const waters = findOnce(isWaterName, WATER_RADIUS);
	const claims = findOnce(
		(n) => isManMadeBlockName(n),
		CLAIM_RADIUS,
		12,
	);

	// Sample surface heights at 5 points around the bot for flatness.
	const surfaceYs = [];
	const offsets = [
		[0, 0], [FLATNESS_RADIUS, 0], [-FLATNESS_RADIUS, 0],
		[0, FLATNESS_RADIUS], [0, -FLATNESS_RADIUS],
	];
	for (const [dx, dz] of offsets) {
		const block = bot.blockAt
			? bot.blockAt({ x: here.x + dx, y: here.y, z: here.z + dz })
			: null;
		if (block?.position) surfaceYs.push(block.position.y);
		else surfaceYs.push(here.y);
	}

	const players = Object.values(bot.entities ?? {})
		.filter((e) => e.type === "player" && e.username && e.username !== bot.username && e.position)
		.map((e) => ({ distance: Math.hypot(e.position.x - here.x, e.position.z - here.z) }));

	return scoreSite({
		blocks: [...woods, ...stones, ...waters, ...claims],
		surfaceYs,
		players,
		position: here,
		isOwned,
	});
}
