// World perception primitives.
//
// PROBLEM: under mineflayer 1.21.4 + ViaBackwards (this server runs
// Paper 26.1.x with VV/VB translating 1.21.5+ protocol down to 1.21.4),
// bot.findBlock and bot.findBlocks with a CALLBACK matcher silently
// return null/empty — the Block objects passed into the callback have a
// wrong `.name` field because the protocol-side block-id mapping has
// drifted from minecraft-data 1.21.4. Confirmed live 2026-05-26 via
// diag.scan: oak_log count in radius 16 = 46 with `matching: numericId`
// but 0 with `matching: (b) => b.name === "oak_log"`.
//
// Mineflayer issue #2347 (findBlocks fails under ViaBackwards) is the
// upstream bug; the workaround is to feed numeric block IDs from the
// bot's registry directly. This module centralises that workaround so
// every skill stops growing its own subtly-broken matcher closure.

export function nameToId(bot, name) {
	return bot.registry?.blocksByName?.[name]?.id ?? null;
}

export function namesToIds(bot, names) {
	const out = [];
	for (const n of names) {
		const id = nameToId(bot, n);
		if (typeof id === "number") out.push(id);
	}
	return out;
}

// Find up to `count` blocks matching any of the given names. Returns an
// array of Vec3 positions, sorted by mineflayer (typically by Manhattan
// distance from the bot). Empty when no name resolves to a registry id.
export function findBlocksByName(bot, names, { maxDistance = 64, count = 32 } = {}) {
	const ids = namesToIds(bot, names);
	if (ids.length === 0) return [];
	return bot.findBlocks({ matching: ids, maxDistance, count }) || [];
}

// Same as findBlocksByName but returns the nearest matching Block object
// (not a Vec3). Skips positions for which a custom predicate returns
// false — used by callers that need post-filter logic like blacklists.
export function findNearestBlockByName(bot, names, { maxDistance = 64, predicate } = {}) {
	const positions = findBlocksByName(bot, names, { maxDistance, count: 32 });
	for (const pos of positions) {
		const blk = bot.blockAt(pos);
		if (!blk) continue;
		if (predicate && !predicate(blk)) continue;
		return blk;
	}
	return null;
}
