// recovery.escape-pit-safe — multi-strategy escape from a hole / pit.
//
// Why this exists alongside recovery.tunnel-out and survive.pillar-up:
//
// tunnel-out tries to dig sideways through walls — fails on
// unbreakable terrain or when there's no clear horizontal exit.
// pillar-up places blocks under the bot and jumps — fails when
// there's a ceiling block above the column.
//
// Both fail silently in a deep cave or 2×2 hole with a ceiling.
// escape-pit-safe surveys options first, then commits:
//
//   1. Scan 4 cardinals at head height + foot height. Pick the one
//      with the closest open path to surface (defined as: column
//      with sky visibility above OR ≥3 air blocks horizontal followed
//      by stairs / slope up).
//   2. If a clear horizontal path exists → recovery.tunnel-out toward it.
//   3. If no horizontal path BUT ceiling is open above us → pillar-up.
//   4. If both blocked → return "stuck" and let the LLM-advisor flag a
//      genuine improvement (e.g. "need water-bucket-MLG", "need to
//      mine through stone").

import { info, warn } from "../log.js";
import { runSkill } from "./index.js";

const SCAN_RADIUS = 6;
const HEAD_OFFSET_Y = 1;

function blockNameAt(bot, x, y, z) {
	try {
		const b = bot.blockAt?.({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
		return b?.name ?? null;
	} catch { return null; }
}

function isAir(name) { return name === "air" || name === "cave_air" || name === "void_air"; }
function isWater(name) { return name === "water" || name === "flowing_water"; }
function isLava(name) { return name === "lava" || name === "flowing_lava"; }
function isPassable(name) { return isAir(name) || (name && /carpet|button|torch|grass$/.test(name)); }

// Look up to 32 blocks straight up from (x,y,z). Return distance to first
// non-air block, or Infinity if open all the way (this is a sky-visible
// column we could pillar-up out of).
function ceilingDistance(bot, x, y, z) {
	for (let dy = HEAD_OFFSET_Y + 1; dy <= 32; dy++) {
		const n = blockNameAt(bot, x, y + dy, z);
		if (!n) return dy; // unloaded chunk = no info; treat conservatively
		if (!isAir(n)) return dy;
	}
	return Infinity;
}

// Scan SCAN_RADIUS blocks in each cardinal at head height. Return
// summary per direction: open-block count, lava/water hits, first
// non-air block name.
function scanCardinals(bot) {
	const pos = bot?.entity?.position;
	if (!pos) return [];
	const head = pos.offset?.(0, HEAD_OFFSET_Y, 0) ?? { x: pos.x, y: pos.y + HEAD_OFFSET_Y, z: pos.z };
	const dirs = [
		{ name: "N", dx: 0, dz: -1 },
		{ name: "E", dx: 1, dz: 0 },
		{ name: "S", dx: 0, dz: 1 },
		{ name: "W", dx: -1, dz: 0 },
	];
	return dirs.map((d) => {
		let openBlocks = 0;
		let lavaAt = -1;
		let waterAt = -1;
		let firstBlock = null;
		for (let r = 1; r <= SCAN_RADIUS; r++) {
			const x = head.x + d.dx * r;
			const z = head.z + d.dz * r;
			const n = blockNameAt(bot, x, head.y, z);
			if (isLava(n) && lavaAt < 0) lavaAt = r;
			if (isWater(n) && waterAt < 0) waterAt = r;
			if (isPassable(n)) {
				openBlocks++;
				if (firstBlock === null) firstBlock = "(air)";
			} else {
				if (firstBlock === null) firstBlock = n ?? "(unknown)";
				break;
			}
		}
		return { ...d, openBlocks, lavaAt, waterAt, firstBlock };
	});
}

export const skill = Object.freeze({
	id: "recovery.escape-pit-safe",
	title: "Escape a pit — survey directions and pick the safest exit",
	timeoutMs: 90_000,
	preconditions(ctx) {
		if (!ctx?.bot?.entity?.position) return { ok: false, code: "no_bot", detail: "bot missing" };
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		const pos = bot.entity.position;
		const dirs = scanCardinals(bot);
		const ceiling = ceilingDistance(bot, pos.x, pos.y, pos.z);

		info(
			"action",
			`escape-pit-safe: cardinals=${dirs.map((d) => `${d.name}:${d.openBlocks}/${d.firstBlock}`).join(" ")} ceiling=${ceiling === Infinity ? "open" : ceiling + "b"}`,
		);

		// 1. Choose the direction with most open blocks (≥3) and no lava.
		const horizontal = dirs
			.filter((d) => d.openBlocks >= 3 && d.lavaAt < 0)
			.sort((a, b) => b.openBlocks - a.openBlocks)[0];

		if (horizontal) {
			info("action", `escape-pit-safe: walking out via ${horizontal.name} (${horizontal.openBlocks}b clear)`);
			// Delegate to wander step or simple controlled walk. Easier:
			// invoke recovery.tunnel-out with a hint of the chosen direction.
			const res = await runSkill("recovery.tunnel-out", ctx, { preferredDir: horizontal.name });
			return {
				ok: !!res?.ok,
				code: res?.code ?? (res?.ok ? "done" : "tunnel_failed"),
				detail: { strategy: "horizontal_walk", direction: horizontal.name, tunnelResult: res?.detail },
				worldDelta: res?.worldDelta ?? { strategy: "horizontal_walk", direction: horizontal.name },
			};
		}

		// 2. No horizontal exit — try pillar-up only if ceiling is open
		// for the bot's height (≥3 blocks: head + 1 build + 1 ceiling slack).
		if (ceiling >= 4) {
			info("action", `escape-pit-safe: ceiling clear (${ceiling}b), trying pillar-up`);
			const res = await runSkill("survive.pillar-up", ctx);
			return {
				ok: !!res?.ok,
				code: res?.code ?? (res?.ok ? "done" : "pillar_failed"),
				detail: { strategy: "pillar_up", ceiling, pillarResult: res?.detail },
				worldDelta: res?.worldDelta ?? { strategy: "pillar_up" },
			};
		}

		// 3. Both blocked — surrender. The LLM-advisor will see this in
		// recent dispatches and can suggest village.relocate or flag a
		// new skill request.
		warn("action", `escape-pit-safe: no viable strategy (horizontal blocked + ceiling ${ceiling}b)`);
		return {
			ok: false,
			code: "no_strategy",
			detail: { horizontal: dirs.map((d) => ({ d: d.name, open: d.openBlocks, lava: d.lavaAt })), ceiling },
			worldDelta: null,
		};
	},
	recover(ctx, result) {
		if (result.code === "no_strategy") {
			return { hint: "wander", reason: "no viable pit-escape; let curriculum try a different action" };
		}
		return null;
	},
});

// Test exports
export const __testing = { scanCardinals, ceilingDistance, isAir, isPassable, SCAN_RADIUS };
