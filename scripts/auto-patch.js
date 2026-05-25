#!/usr/bin/env node
// auto-patch.js <proposal-filename>
//
// Unattended sibling of propose-apply.js. Picks an *unapproved* proposal,
// moves it to approved/, branches off main, runs `pi -p` headless, and if Pi
// commits something — cherry-picks the commit back into main. The point is
// to close the self-improvement loop with no operator interaction.
//
// Exit codes:
//   0  patch applied cleanly (commit on main)
//   1  pi spawned but produced no commit (no change to repo)
//   2  preflight failed (dirty tree, missing proposal, etc.)
//   3  pi exited non-zero
//   4  cherry-pick conflict — left in unresolved state on a branch
//
// Designed to be launched by runtime/auto-improve.js as a detached child.
// We deliberately avoid touching anything outside the repo and don't push.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function log(level, msg) {
	const line = `${new Date().toISOString()} [auto-patch] [${level}] ${msg}`;
	if (level === "error" || level === "warn") console.error(line);
	else console.log(line);
}

function git(args, opts = {}) {
	return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", ...opts });
}

function exit(code, reason) {
	log(code === 0 ? "info" : "warn", `exit ${code}: ${reason}`);
	process.exit(code);
}

const filenameArg = process.argv[2];
if (!filenameArg) exit(2, "usage: auto-patch.js <proposal-filename>");

function findProposal(filename) {
	const stateRoot = path.join(REPO_ROOT, "state");
	if (!fs.existsSync(stateRoot)) return null;
	for (const host of fs.readdirSync(stateRoot)) {
		const pending = path.join(stateRoot, host, "proposals", filename);
		const approved = path.join(stateRoot, host, "proposals", "approved", filename);
		if (fs.existsSync(pending)) return { path: pending, host, status: "pending" };
		if (fs.existsSync(approved)) return { path: approved, host, status: "approved" };
	}
	return null;
}

const proposal = findProposal(filenameArg);
if (!proposal) exit(2, `proposal not found: ${filenameArg}`);

// Refuse on dirty tree — we'd lose the operator's WIP.
const dirty = git(["status", "--porcelain"]).stdout.trim();
if (dirty) exit(2, `working tree dirty: ${dirty.split("\n")[0]}`);

// Move pending → approved so we don't try to apply the same proposal twice.
if (proposal.status === "pending") {
	const approvedDir = path.join(path.dirname(proposal.path), "approved");
	fs.mkdirSync(approvedDir, { recursive: true });
	const dst = path.join(approvedDir, filenameArg);
	const content = fs.readFileSync(proposal.path, "utf8").replace(/^approved: false/m, "approved: true (auto)");
	fs.writeFileSync(dst, content);
	fs.unlinkSync(proposal.path);
	proposal.path = dst;
	log("info", `moved pending → approved: ${filenameArg}`);
}

const proposalText = fs.readFileSync(proposal.path, "utf8");

// Capture current main HEAD so we can roll back to it if cherry-pick fails.
const baseSha = git(["rev-parse", "HEAD"]).stdout.trim();

const slug = filenameArg
	.replace(/\.md$/, "")
	.replace(/[^a-zA-Z0-9-]+/g, "-")
	.slice(0, 60);
const branch = `auto/${slug}`;

// Delete the branch if it exists from a previous failed attempt.
git(["branch", "-D", branch]); // ignore error if absent

const checkout = git(["checkout", "-b", branch]);
if (checkout.status !== 0) exit(2, `cannot create branch ${branch}: ${checkout.stderr}`);

const prompt = [
	"You are patching the pepa-pi-bot repo to address an automatically-detected failure.",
	"This is an UNATTENDED run — no operator will review your output before it lands on main.",
	"Be conservative. Prefer guard clauses and small surgical edits.",
	"",
	"## The proposal",
	"",
	proposalText,
	"",
	"## Hard rules (non-negotiable)",
	"",
	"1. Touch only files under `runtime/`. Do NOT modify `tui/`, `extensions/`, `scripts/`, `docs/`, `package.json`, or anything in `state/`.",
	"2. Do not introduce npm dependencies.",
	"3. Do not push, do not open a PR. Commit on the current branch only.",
	"4. Use a conventional commit message: `fix(runtime/<file>): <one-line summary>`.",
	"5. If you can't safely fix the issue, write a short comment in the relevant runtime file explaining why and stop — do NOT make a speculative change.",
	"6. Make exactly ONE commit. If you find multiple issues, focus on the one the proposal describes.",
	"",
	"After you commit, your job is done.",
].join("\n");

log("info", `spawning pi -p (timeout 10 min)`);
const pi = spawn("pi", ["-p", prompt], {
	cwd: REPO_ROOT,
	stdio: ["ignore", "pipe", "pipe"],
});

let piStdout = "";
let piStderr = "";
pi.stdout.on("data", (chunk) => {
	piStdout += chunk.toString();
});
pi.stderr.on("data", (chunk) => {
	piStderr += chunk.toString();
});

const PI_TIMEOUT_MS = 10 * 60 * 1000;
const timer = setTimeout(() => {
	log("warn", "pi timeout — killing subprocess");
	pi.kill("SIGTERM");
}, PI_TIMEOUT_MS);

pi.on("exit", (code) => {
	clearTimeout(timer);
	log("info", `pi exited code=${code}; stdout=${piStdout.length}B stderr=${piStderr.length}B`);

	if (code !== 0) {
		// Pi crashed or timed out — return to main, drop the branch.
		git(["checkout", "main"]);
		git(["branch", "-D", branch]);
		exit(3, `pi exited ${code}`);
	}

	const newHead = git(["rev-parse", "HEAD"]).stdout.trim();
	if (newHead === baseSha) {
		// Pi did not commit anything. Clean up.
		git(["checkout", "main"]);
		git(["branch", "-D", branch]);
		exit(1, "pi made no commit");
	}

	// Verify the commit touched only runtime/.
	const filesChanged = git(["diff", "--name-only", `${baseSha}..HEAD`]).stdout.trim().split("\n").filter(Boolean);
	const outside = filesChanged.filter((f) => !f.startsWith("runtime/"));
	if (outside.length > 0) {
		log("error", `commit touched files outside runtime/: ${outside.join(", ")} — discarding`);
		git(["checkout", "main"]);
		git(["branch", "-D", branch]);
		exit(2, "patch touched off-limits files");
	}

	// Cherry-pick onto main.
	git(["checkout", "main"]);
	const cherry = git(["cherry-pick", newHead]);
	if (cherry.status !== 0) {
		log("error", `cherry-pick failed: ${cherry.stderr}`);
		// Leave the branch around for operator inspection; abort the failed
		// cherry-pick so main is clean.
		git(["cherry-pick", "--abort"]);
		exit(4, `cherry-pick conflict — see branch ${branch}`);
	}

	// Success — delete the feature branch (the commit is on main now).
	git(["branch", "-D", branch]);
	log("info", `patch applied to main as ${git(["rev-parse", "HEAD"]).stdout.trim().slice(0, 8)}`);
	exit(0, `applied ${filenameArg}`);
});
