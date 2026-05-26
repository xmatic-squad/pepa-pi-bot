// diag.scan / diag.match — ground-truth probes of bot.findBlock(s).
// Counts how many instances of common blocks are visible at increasing
// radii. Lets the operator (or a stuck detector) tell two failure modes
// apart:
//
//   case A: grass_block.32 > 0 but oak_log.96 = 0 → world has no trees
//   case B: grass_block.32 = 0 → findBlocks itself is broken (mineflayer
//                                issue #2347 under ViaBackwards), and
//                                gather.* skills will silently no-op
//                                forever no matter how far we walk.
//
// Writes nothing to journal. Always returns ok so it never wedges.

const TYPES = ["grass_block", "dirt", "stone", "oak_log", "birch_log", "spruce_log", "jungle_log", "coal_ore", "iron_ore"];
const RADII = [16, 32, 64, 96];
const LOG_NAMES = ["oak_log", "dark_oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "mangrove_log", "cherry_log", "pale_oak_log"];

export const matchSkill = Object.freeze({
	id: "diag.match",
	title: "Compare findBlock matcher styles for logs",
	timeoutMs: 15_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		const mcData = bot.registry;
		const ids = LOG_NAMES.map((n) => mcData?.blocksByName?.[n]?.id).filter((x) => typeof x === "number");
		const r = 32;
		// Style A: numeric matching (what diag.scan uses, and what works)
		const a = (bot.findBlocks({ matching: ids, maxDistance: r, count: 50 }) || []).length;
		// Style B: callback matching by .name (what chopNearestTree uses, and what fails)
		const b = (bot.findBlocks({
			matching: (blk) => !!blk && !!blk.position && LOG_NAMES.includes(blk.name),
			maxDistance: r,
			count: 50,
		}) || []).length;
		// Style C: callback matching by .type (numeric id) — control
		const c = (bot.findBlocks({
			matching: (blk) => !!blk && ids.includes(blk.type),
			maxDistance: r,
			count: 50,
		}) || []).length;
		// Style D: singular findBlock with callback matcher (what chopNearestTree literally calls)
		const d = bot.findBlock({
			matching: (blk) => !!blk && !!blk.position && LOG_NAMES.includes(blk.name),
			maxDistance: r,
		});
		// Style E: singular findBlock with numeric id array
		const e = bot.findBlock({ matching: ids, maxDistance: r });
		return {
			ok: true,
			code: "match_done",
			detail: {
				ids,
				radius: r,
				A_findBlocks_numeric: a,
				B_findBlocks_callback_name: b,
				C_findBlocks_callback_type: c,
				D_findBlock_callback_name: d ? { name: d.name, type: d.type, pos: { x: d.position.x, y: d.position.y, z: d.position.z } } : null,
				E_findBlock_numeric: e ? { name: e.name, type: e.type, pos: { x: e.position.x, y: e.position.y, z: e.position.z } } : null,
			},
			worldDelta: null,
		};
	},
});

export const skill = Object.freeze({
	id: "diag.scan",
	title: "Scan for findBlocks visibility",
	timeoutMs: 20_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		const mcData = bot.registry;
		const here = bot.entity.position.clone();
		const report = {};
		for (const name of TYPES) {
			const blk = mcData?.blocksByName?.[name];
			if (!blk) {
				report[name] = { absent_in_registry: true };
				continue;
			}
			const perRadius = {};
			for (const r of RADII) {
				const hits = bot.findBlocks({ matching: blk.id, maxDistance: r, count: 50 }) || [];
				perRadius[r] = hits.length;
			}
			report[name] = perRadius;
		}
		// Also blockAt directly underfoot and 5-block ring scan: this bypasses
		// findBlocks entirely and proves whether the protocol decode is sane.
		const under = bot.blockAt(here.offset(0, -1, 0));
		const ring = {};
		for (let dx = -5; dx <= 5; dx++) {
			for (let dz = -5; dz <= 5; dz++) {
				const b = bot.blockAt(here.offset(dx, -1, dz));
				if (!b) continue;
				ring[b.name] = (ring[b.name] || 0) + 1;
			}
		}
		return {
			ok: true,
			code: "scan_done",
			detail: {
				pos: { x: +here.x.toFixed(1), y: +here.y.toFixed(1), z: +here.z.toFixed(1) },
				under: under?.name ?? null,
				ring_11x11_underfoot: ring,
				findBlocks: report,
			},
			worldDelta: null,
		};
	},
});
