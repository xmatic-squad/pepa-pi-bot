// diag.physics — one-shot ground truth probe. Tests whether
// setControlState("forward"), setControlState("jump"), and bot.dig
// actually do anything on this server. Writes results to the diary so
// the operator can inspect later. NOT for production loops — it has
// side effects (1-2 blocks moved if forward works) and we don't want
// to dispatch it every tick.
//
// Triggered by: explicit IPC command (cmd:probe-physics) or by the
// curriculum once if the bot has been "working" but its position
// hasn't changed by more than 4 blocks in 5 min. We add the curriculum
// trigger in a follow-up.

import { info, warn } from "../log.js";
import { appendDiary } from "../state-store.js";

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Probe forward by trying every cardinal direction in sequence and
// keeping the BEST result. If the bot is wedged on a single side
// (treetop with leaves on one side, open air on the other) we still
// get a true positive instead of a false "BROKEN".
async function probeForward(bot, durationMsPerDir = 1_200) {
	const before = bot.entity.position.clone();
	const trials = [];
	const yaws = [
		{ name: "N", yaw: Math.PI },           // -Z
		{ name: "E", yaw: -Math.PI / 2 },      // +X
		{ name: "S", yaw: 0 },                  // +Z
		{ name: "W", yaw: Math.PI / 2 },       // -X
	];
	for (const { name, yaw } of yaws) {
		try { await bot.look(yaw, 0, true); } catch {}
		const t0 = bot.entity.position.clone();
		try {
			bot.setControlState("forward", true);
			await new Promise((r) => setTimeout(r, durationMsPerDir));
		} finally {
			bot.setControlState("forward", false);
		}
		const t1 = bot.entity.position;
		const dx = t1.x - t0.x;
		const dz = t1.z - t0.z;
		const dist = Math.hypot(dx, dz);
		trials.push({ dir: name, dist });
		// settle gravity
		await new Promise((r) => setTimeout(r, 300));
	}
	const best = trials.reduce((b, t) => (t.dist > b.dist ? t : b), { dir: "?", dist: 0 });
	const after = bot.entity.position.clone();
	return {
		before, after,
		trials,
		bestDir: best.dir,
		bestDist: best.dist,
		works: best.dist > 0.5,
	};
}

async function probeJump(bot) {
	const startY = bot.entity.position.y;
	let maxY = startY;
	const start = Date.now();
	try {
		bot.setControlState("jump", true);
		while (Date.now() - start < 800) {
			await new Promise((r) => setTimeout(r, 50));
			if (bot.entity.position.y > maxY) maxY = bot.entity.position.y;
		}
	} finally {
		bot.setControlState("jump", false);
	}
	return { startY, maxY, deltaY: maxY - startY, works: maxY - startY > 0.4 };
}

async function probeDig(bot) {
	const ds = ["sand", "dirt", "grass_block", "stone", "cobblestone", "gravel", "oak_log", "oak_leaves", "leaves"];
	const target = bot.findBlock({
		matching: (b) => b && b.position && ds.includes(b.name) && b.position.y >= bot.entity.position.y - 3,
		maxDistance: 6,
	});
	if (!target) return { works: false, reason: "no soft block within 6 to test on" };

	const tPos = target.position.clone();
	const tName = target.name;
	try {
		await withTimeout(bot.lookAt(tPos.offset(0.5, 0.5, 0.5), true), 2_000, "lookAt");
	} catch {}
	try {
		await withTimeout(bot.dig(target), 12_000, "dig");
	} catch (e) {
		return { works: false, reason: `dig threw: ${e.message}`, name: tName, at: tPos };
	}
	const after = bot.blockAt(tPos);
	const gone = !after || after.name === "air" || after.name === "cave_air" || after.name === "void_air";
	return { works: gone, before: tName, after: after?.name ?? "(none)", at: tPos };
}

export const skill = Object.freeze({
	id: "diag.physics",
	title: "Probe forward/jump/dig and report",
	timeoutMs: 30_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		info("action", "diag.physics: starting probe");

		const fwd = await probeForward(bot);
		const trialsStr = fwd.trials?.map((t) => `${t.dir}:${t.dist.toFixed(1)}`).join(" ") ?? "?";
		info("action", `diag.physics: forward bestΔ=${fwd.bestDist.toFixed(2)} (${fwd.bestDir}) trials=[${trialsStr}] (${fwd.works ? "OK" : "BROKEN"})`);

		const jmp = await probeJump(bot);
		info("action", `diag.physics: jump ΔY=${jmp.deltaY.toFixed(2)} (${jmp.works ? "OK" : "BROKEN"})`);

		const dig = await probeDig(bot);
		info("action", `diag.physics: dig ${dig.before ?? "?"}→${dig.after ?? "?"} (${dig.works ? "OK" : "BROKEN"}: ${dig.reason ?? ""})`);

		const summary = `physics probe: forward=${fwd.works ? "ok" : "BROKEN"}(best=${fwd.bestDir}@${fwd.bestDist.toFixed(1)}) jump=${jmp.works ? "ok" : "BROKEN"}(Δy${jmp.deltaY.toFixed(1)}) dig=${dig.works ? "ok" : "BROKEN"}(${dig.before ?? "no-target"}→${dig.after ?? "?"})`;
		appendDiary(summary);

		return {
			ok: true,
			code: "done",
			detail: {
				forward: fwd,
				jump: jmp,
				dig: dig,
			},
			worldDelta: {
				probe: {
					forwardWorks: fwd.works,
					jumpWorks: jmp.works,
					digWorks: dig.works,
				},
			},
		};
	},
});
