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

import { stateDir } from "./config.js";
import { info, warn } from "./log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PATCH_SCRIPT = path.join(REPO_ROOT, "scripts", "auto-patch.js");
const PROPOSALS_DIR = path.join(stateDir, "proposals");

const DEBOUNCE_MS = 10_000;
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_TOTAL_PER_HOUR = 4;

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
	info("auto-improve", `spawning auto-patch for ${filename}`);
	inFlight = true;
	const child = spawn(process.execPath, [PATCH_SCRIPT, filename], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
		detached: false,
	});
	let stdoutBuf = "";
	let stderrBuf = "";
	child.stdout.on("data", (c) => {
		stdoutBuf += c.toString();
	});
	child.stderr.on("data", (c) => {
		stderrBuf += c.toString();
	});
	child.on("exit", (code) => {
		inFlight = false;
		lastFinishedAt = Date.now();
		recentRuns.push(lastFinishedAt);
		const tail = (stdoutBuf + "\n" + stderrBuf).trim().split("\n").slice(-3).join(" | ");
		if (code === 0) info("auto-improve", `patch applied for ${filename}: ${tail}`);
		else warn("auto-improve", `patch did not apply (code=${code}) for ${filename}: ${tail}`);
		// We do NOT trigger supervisor restart manually — the supervisor's
		// fs.watch on runtime/*.js fires the moment the cherry-pick lands.
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
	info("auto-improve", `watching ${PROPOSALS_DIR} (cooldown=${COOLDOWN_MS / 1000}s, max ${MAX_TOTAL_PER_HOUR}/hr)`);
	pollTimer = setInterval(tick, 2000);
}

export function stopAutoImprover() {
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = null;
}
