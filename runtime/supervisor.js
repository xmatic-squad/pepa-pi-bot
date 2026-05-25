// Supervisor: forks runtime/bot.js as a child process and restarts it
// when the child exits with a "reload requested" code (RELOAD_EXIT_CODE).
// Also watches runtime/*.js — when a file changes, signals the child to
// reload itself by exiting with the same code.
//
// True hot module reload in Node ESM is fragile (caches, open sockets,
// mineflayer client state). Restart-on-change is the same outcome with
// none of the gotchas: the only thing the bot loses is the MC TCP
// connection, which it would reconnect anyway after a Mineflayer kick.
//
// Run via `npm run bot`. Falls back to plain `node runtime/bot.js` via
// `npm run bot:bare` if you want to skip the supervisor.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_DIR = __dirname;
const BOT_ENTRY = path.join(RUNTIME_DIR, "bot.js");

export const RELOAD_EXIT_CODE = 42;
const WATCH_DEBOUNCE_MS = 800;
const MAX_RESTARTS_PER_MINUTE = 5;

let child = null;
let restartingDueToWatch = false;
const restartTimestamps = [];

function nowMs() {
	return Date.now();
}

function spawnChild() {
	child = spawn(process.execPath, [BOT_ENTRY], {
		stdio: "inherit",
		env: { ...process.env, PEPA_SUPERVISED: "1" },
	});

	child.on("exit", (code, signal) => {
		console.log(`[supervisor] child exited code=${code} signal=${signal}`);
		const wantsRestart = code === RELOAD_EXIT_CODE || restartingDueToWatch;
		restartingDueToWatch = false;
		if (!wantsRestart) {
			// Clean exit (SIGINT/SIGTERM bubble) or crash — don't relaunch.
			process.exit(code ?? 0);
		}
		// Rate-limit restarts so a crash loop doesn't burn CPU.
		const now = nowMs();
		restartTimestamps.push(now);
		while (restartTimestamps.length && now - restartTimestamps[0] > 60_000) restartTimestamps.shift();
		if (restartTimestamps.length > MAX_RESTARTS_PER_MINUTE) {
			console.error(`[supervisor] too many restarts (${restartTimestamps.length} in 60s) — giving up`);
			process.exit(1);
		}
		console.log(`[supervisor] restarting in 500ms…`);
		setTimeout(spawnChild, 500);
	});

	child.on("error", (err) => {
		console.error(`[supervisor] failed to spawn child: ${err.message}`);
		process.exit(1);
	});
}

let debounceTimer = null;
function watchRuntime() {
	const watcher = fs.watch(RUNTIME_DIR, { recursive: false }, (eventType, filename) => {
		if (!filename || !filename.endsWith(".js")) return;
		// supervisor.js itself is excluded — restarting THIS process from
		// inside itself would require a separate exec, which we don't do.
		if (filename === "supervisor.js") return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			console.log(`[supervisor] ${filename} changed — restarting child`);
			restartingDueToWatch = true;
			child?.kill("SIGTERM");
		}, WATCH_DEBOUNCE_MS);
	});
	watcher.on("error", (err) => {
		console.error(`[supervisor] watcher error: ${err.message}`);
	});
}

// Forward signals to the child, then exit ourselves once it has.
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		console.log(`[supervisor] forwarding ${sig} to child`);
		if (!child) process.exit(0);
		child.once("exit", () => process.exit(0));
		child.kill(sig);
		// hard cap in case the child hangs
		setTimeout(() => process.exit(1), 5000).unref();
	});
}

console.log(`[supervisor] starting; watching ${RUNTIME_DIR} for *.js changes`);
spawnChild();
watchRuntime();
