#!/usr/bin/env node
// propose:apply <filename>
//
// Take an approved proposal from state/<host>/proposals/approved/, build a
// task prompt for Pi headless, hand it the proposal + relevant repo context,
// and let Pi write the patch on a new feature branch. The script:
//
//   1. Verifies the proposal exists in proposals/approved/.
//   2. Refuses to run on a dirty working tree.
//   3. Creates a new branch `feat/proposal-<slug>` off the current HEAD.
//   4. Spawns `pi -p "<prompt>"` and streams its stdout to the terminal.
//   5. After Pi exits, prints the resulting `git status` so the operator
//      can inspect what changed before pushing/merging.
//
// We do NOT push or merge automatically — the operator reviews `git diff`,
// runs the smoke test, and decides.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const filenameArg = process.argv[2];
if (!filenameArg) {
	console.error("usage: npm run propose:apply <filename>");
	process.exit(2);
}

function findApproved(filename) {
	const stateRoot = path.join(REPO_ROOT, "state");
	if (!fs.existsSync(stateRoot)) return null;
	for (const host of fs.readdirSync(stateRoot)) {
		const candidate = path.join(stateRoot, host, "proposals", "approved", filename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

const proposalPath = findApproved(filenameArg);
if (!proposalPath) {
	console.error(`proposal not found in any state/<host>/proposals/approved/: ${filenameArg}`);
	process.exit(3);
}

const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT })
	.stdout.toString()
	.trim();
if (dirty) {
	console.error("working tree is dirty — commit or stash first");
	console.error(dirty);
	process.exit(4);
}

const slug = filenameArg
	.replace(/\.md$/, "")
	.replace(/[^a-zA-Z0-9-]+/g, "-")
	.slice(0, 60);
const branch = `feat/proposal-${slug}`;

const branchRes = spawnSync("git", ["checkout", "-b", branch], { cwd: REPO_ROOT, stdio: "inherit" });
if (branchRes.status !== 0) {
	console.error(`could not create branch ${branch}`);
	process.exit(5);
}

const proposalText = fs.readFileSync(proposalPath, "utf8");

const prompt = [
	"You are about to patch the pepa-pi-bot repo to address an approved proposal.",
	"",
	"## The proposal",
	"",
	proposalText,
	"",
	"## Your task",
	"",
	"Read the proposal carefully. Make a *minimal* patch to address the underlying problem.",
	"",
	"Rules:",
	"1. Touch as few files as possible. Prefer fixing the smallest thing that addresses the root cause.",
	"2. The fix should land under `runtime/` (the hybrid runtime) — NOT under `extensions/` (Pi-only legacy).",
	"3. Honor the existing patterns:",
	"   - Reflexes live in `runtime/reflex.js` and follow the `(ctx) => { action, ... }` shape.",
	"   - Actions live in `runtime/actions.js` and return `{ ok, detail }` with a hard timeout.",
	"   - State on disk goes through `runtime/state-store.js`.",
	"4. Add or update a short comment explaining WHY only if the change is non-obvious.",
	"5. Do not introduce new npm dependencies without a strong reason.",
	"6. Do not push, do not open a PR — just commit on the current branch.",
	"7. Use a conventional commit message (feat/fix/refactor scope).",
	"",
	"When you're done, commit and stop. The operator will review.",
].join("\n");

console.log("\n=== spawning pi -p (this may take a few minutes) ===\n");
const child = spawn("pi", ["-p", prompt], { cwd: REPO_ROOT, stdio: "inherit" });
child.on("exit", (code) => {
	console.log(`\n=== pi exited code=${code} ===\n`);
	console.log("git status:");
	spawnSync("git", ["status"], { cwd: REPO_ROOT, stdio: "inherit" });
	console.log("\nDiff summary:");
	spawnSync("git", ["diff", "--stat", "HEAD~1..HEAD"], { cwd: REPO_ROOT, stdio: "inherit" });
	console.log(`\nBranch: ${branch}`);
	console.log(`Next steps: review the diff, smoke-test with 'npm run bot', then 'git push -u origin ${branch}' if good.`);
	process.exit(code ?? 0);
});
