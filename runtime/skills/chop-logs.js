// gather.logs — find the nearest log block matching the server's log
// registry, path to it, mine it. Wraps the existing actions.js primitive
// while exposing the survival-skill contract (preconditions, timeout,
// structured worldDelta, recovery hint).

import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals } = pathfinderPkg;

import { chopNearestTree } from "../actions.js";
import { logs as logBlocks } from "./groups.js";
import { info } from "../log.js";

let pluginLoaded = new WeakSet();
function ensurePathfinder(bot) {
	if (pluginLoaded.has(bot)) return;
	bot.loadPlugin(pathfinder);
	pluginLoaded.add(bot);
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const skill = Object.freeze({
	id: "gather.logs",
	title: "Gather logs",
	timeoutMs: 60_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		const known = logBlocks(ctx.bot);
		if (known.size === 0) {
			return { ok: false, code: "unsupported_version", detail: "no log blocks in registry" };
		}
		return { ok: true };
	},
	async execute(ctx) {
		// Journal-aware approach: if we previously chopped a tree (or saw a
		// tree marker) within 96 blocks, walk to that bucket first — the
		// chunk has been confirmed to contain trees, so the next chop is
		// likely to succeed there even if findBlock at the current position
		// returned nothing.
		const bot = ctx.bot;
		const here = bot.entity?.position;
		if (here && ctx?.journal?.nearest) {
			const near = ctx.journal.nearest({ kind: "chopped", x: here.x, z: here.z, radius: 96, limit: 1 });
			if (near.length && near[0].distance > 8) {
				ensurePathfinder(bot);
				const t = near[0].at;
				info("action", `gather.logs: journal hint → walk to known tree area ${t.x},${t.y},${t.z} (${near[0].distance.toFixed(0)}m)`);
				try {
					await withTimeout(
						bot.pathfinder.goto(new goals.GoalNear(t.x, t.y, t.z, 6)),
						25_000,
						"gotoTreeArea",
					);
				} catch {} // ignore, fall through to chop attempt
			}
		}
		const res = await chopNearestTree(ctx.bot);
		if (res.ok) {
			return {
				ok: true,
				code: "done",
				detail: res.detail,
				worldDelta: {
					choppedAt: res.detail?.at ?? null,
					logType: res.detail?.logType ?? null,
				},
			};
		}
		const msg = String(res.detail ?? "");
		// res.code can come straight from actions.js (silent_dig_failure),
		// otherwise we classify from the detail string.
		const code = res.code
			? res.code
			: (msg.includes("no reachable log") || msg.includes("no log within"))
				? "no_target"
				: msg.includes("timed out")
					? "timeout"
					: "failed";
		return { ok: false, code, detail: res.detail, worldDelta: null };
	},
	validate(ctx, result) {
		return result.ok && !!result.worldDelta?.logType;
	},
	recover(ctx, result) {
		// Tell the caller: if there was no reachable log, switching to wander
		// for ~60 s is the right next move — same heuristic the autonomous
		// reflex already uses.
		if (result.code === "no_target") {
			return { hint: "wander", reason: "no log within 32 blocks" };
		}
		return null;
	},
});
