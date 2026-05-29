// Auto-improve watcher: when a new proposal file appears under
// state/<host>/proposals/, debounce briefly (in case the writer is still
// finishing), then spawn scripts/auto-patch.js as a detached background
// process. The patcher creates a branch, runs Pi headless, and cherry-picks
// any resulting commit onto main. The supervisor's runtime/*.js watcher
// then triggers a child restart picking up the new code.
//
// One auto-improve in flight at a time; a 15-minute cooldown between
// finished runs caps the Pi token burn rate. Failures keep the proposal
// in approved/ (already auto-moved by the patcher) so a future run could
// retry — but with the cooldown, this isn't a tight loop.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, stateDir } from "./config.js";
import { info, warn } from "./log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PATCH_SCRIPT = path.join(REPO_ROOT, "scripts", "auto-patch.js");
const PROPOSALS_DIR = path.join(stateDir, "proposals");

const DEBOUNCE_MS = 10_000;
const COOLDOWN_MS = config.autoImproveCooldownMs;
const MAX_TOTAL_PER_HOUR = config.autoImproveMaxPerHour;

let inFlight = false;
let lastFinishedAt = 0;
const recentRuns = []; // timestamps

function withinHourlyCap() {
	const now = Date.now();
	while (recentRuns.length && now - recentRuns[0] > 3600_000) recentRuns.shift();
	return recentRuns.length >= MAX_TOTAL_PER_HOUR;
}

function listPendingProposals() {
	try {
		return fs
			.readdirSync(PROPOSALS_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

function spawnPatcher(filename) {
	info("auto-improve", `spawning auto-patch for ${filename} (detached)`);
	inFlight = true;
	// detached:true so the auto-patch child survives a supervisor restart
	// (which fires every time auto-patch's own commit lands and supervisor
	// notices runtime/*.js changed). Without this, Pi can write a perfect
	// commit on an auto/* branch but auto-patch gets killed BEFORE the
	// cherry-pick step. Observed live 2026-05-26: lost an
	// eb29591-quality fix that way; recovered manually via git
	// reflog + cherry-pick. We also pipe stdout/stderr to a log file
	// per-run so the operator can see Pi's full output later.
	const logPath = path.join(REPO_ROOT, "state", "_auto-patch-last.log");
	let logFd;
	try { logFd = fs.openSync(logPath, "w"); } catch { logFd = "ignore"; }
	const child = spawn(process.execPath, [PATCH_SCRIPT, filename], {
		cwd: REPO_ROOT,
		stdio: ["ignore", logFd, logFd],
		env: { ...process.env },
		detached: true,
	});
	child.unref(); // critical: parent (bot.js) can exit without waiting
	child.on("exit", (code) => {
		inFlight = false;
		lastFinishedAt = Date.now();
		recentRuns.push(lastFinishedAt);
		if (code === 0) info("auto-improve", `patch applied for ${filename} (see ${logPath} for full output)`);
		else warn("auto-improve", `patch did not apply (code=${code}) for ${filename} (see ${logPath})`);
	});
	child.on("error", (e) => {
		warn("auto-improve", `spawn error: ${e.message}`);
		inFlight = false;
	});
}

function tick() {
	if (inFlight) return;
	if (withinHourlyCap()) return;
	if (Date.now() - lastFinishedAt < COOLDOWN_MS) return;

	const pending = listPendingProposals();
	if (pending.length === 0) return;

	// Pick the oldest pending proposal (sorted lexically — timestamps in name).
	const filename = pending[0];

	// Debounce: ensure the file has been still for DEBOUNCE_MS so we don't
	// race a partial write. Track first-seen timestamp per filename.
	if (!debounceMap.has(filename)) {
		debounceMap.set(filename, Date.now());
		return;
	}
	const firstSeen = debounceMap.get(filename);
	if (Date.now() - firstSeen < DEBOUNCE_MS) return;

	debounceMap.delete(filename);
	spawnPatcher(filename);
}

const debounceMap = new Map();
let pollTimer = null;

export function startAutoImprover() {
	if (pollTimer) return;
	// Off-switch: the self-patcher commits LLM-generated diffs and checks out
	// branches, which can leave the working tree on the wrong branch mid-run
	// (observed 2026-05-28: it checked out a stale local `main`). The research
	// direction is operator-drained improvement_requests, not auto-apply — so
	// set PEPA_AUTO_IMPROVE=off to keep proposals on disk without patching.
	if (String(process.env.PEPA_AUTO_IMPROVE ?? "").toLowerCase() === "off") {
		info("auto-improve", "disabled via PEPA_AUTO_IMPROVE=off — proposals written but not auto-applied");
		return;
	}
	info("auto-improve", `watching ${PROPOSALS_DIR} (cooldown=${COOLDOWN_MS / 1000}s, max ${MAX_TOTAL_PER_HOUR}/hr)`);
	pollTimer = setInterval(tick, 2000);
}

export function stopAutoImprover() {
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = null;
}
