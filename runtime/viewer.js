// Two viewer surfaces:
//   1. maybeStartViewer(bot) — long-running HTTP browser viewer at
//      VIEWER_PORT (optional, opt-in). Useful for live operator
//      debugging.
//   2. takeScreenshot(bot, opts) — on-demand headless render of "what
//      the bot sees right now" → PNG-equivalent file under
//      state/<host>/screenshots/. Drives cmd:screenshot IPC and can be
//      embedded in proposal bodies.
//
// Both require prismarine-viewer (npm i prismarine-viewer). If missing,
// each function logs and returns gracefully.

import fs from "node:fs";
import path from "node:path";
import { info, warn } from "./log.js";
import { config, stateDir } from "./config.js";

let started = false;

export async function maybeStartViewer(bot) {
	if (started) return;
	const port = config.viewerPort;
	if (!port) return;
	let mineflayerViewer;
	try {
		({ mineflayer: mineflayerViewer } = await import("prismarine-viewer"));
	} catch (e) {
		warn("viewer", `VIEWER_PORT=${port} requested but prismarine-viewer is not installed (npm i prismarine-viewer)`);
		return;
	}
	try {
		mineflayerViewer(bot, { port, firstPerson: false });
		started = true;
		info("viewer", `prismarine-viewer listening on http://localhost:${port}`);
	} catch (e) {
		warn("viewer", `failed to start: ${e?.message ?? e}`);
	}
}

// --- On-demand screenshot ---------------------------------------------

const SHOT_DIR = path.join(stateDir, "screenshots");

function ensureShotDir() {
	try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch {}
}

function shotSlug(reason) {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const r = String(reason ?? "manual").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 32);
	return `${ts}-${r}`;
}

let headlessFn = null;
async function loadHeadless() {
	if (headlessFn) return headlessFn;
	const mod = await import("prismarine-viewer");
	headlessFn = mod.headless ?? mod.default?.headless ?? null;
	if (!headlessFn) throw new Error("prismarine-viewer.headless export missing");
	return headlessFn;
}

// Take one rendered frame from the bot's POV. prismarine-viewer's
// `headless()` writes an mp4 (1 frame ≈ ~10KB), which we keep as-is —
// any tool that can read mp4 (ffmpeg, mpv, QuickTime) will display it.
// We accept this over rolling our own renderer.
export async function takeScreenshot(bot, { reason = "manual", frames = 1, width = 512, height = 384, viewDistance = 6 } = {}) {
	if (!bot) return { ok: false, error: "no bot" };
	ensureShotDir();
	const outPath = path.join(SHOT_DIR, `${shotSlug(reason)}.mp4`);
	let hl;
	try { hl = await loadHeadless(); }
	catch (e) {
		warn("viewer", `headless not available: ${e.message}`);
		return { ok: false, error: `viewer load: ${e.message}` };
	}
	try {
		await hl(bot, { output: outPath, frames, width, height, viewDistance });
		info("viewer", `screenshot saved: ${outPath} (reason=${reason})`);
		return { ok: true, path: outPath, reason };
	} catch (e) {
		warn("viewer", `screenshot failed: ${e.message}`);
		return { ok: false, error: e.message };
	}
}

export const _internal = { shotSlug, SHOT_DIR };
