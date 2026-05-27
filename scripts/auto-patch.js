#!/usr/bin/env node
// auto-patch.js <proposal-filename>
//
// Unattended sibling of propose-apply.js. Picks an *unapproved* proposal,
// moves it to approved/, branches off main, runs `pi -p` headless, and if Pi
// commits something — pushes the branch to origin and opens a GitHub PR for
// operator review. The operator is the only one who can merge into main
// (enforced by branch protection rules).
//
// This is a v0.2.0 behavioural change. Earlier versions cherry-picked
// auto-patch commits straight onto main, which caused chaotic merge races
// against operator work. Now main is review-only.
//
// Exit codes:
//   0  PR opened cleanly (or already exists)
//   1  pi spawned but produced no commit (no change to repo)
//   2  preflight failed (dirty tree, missing proposal, etc.)
//   3  pi exited non-zero
//   4  push or `gh pr create` failed — branch left on disk for inspection
//   5  optional fallback path: PR open disabled and cherry-pick conflict
//
// Override:
//   PEPA_AUTO_PATCH_MERGE=cherry-pick   ← legacy direct-merge (NOT recommended)
//
// Designed to be launched by runtime/auto-improve.js as a detached child.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEditScope, validateChangedFiles, effectiveScope } from "./edit-scope.js";
import { lintPatch } from "./lint-patch.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const LOCK_FILE = path.join(REPO_ROOT, "state", "auto-patch.lock");

function log(level, msg) {
	const line = `${new Date().toISOString()} [auto-patch] [${level}] ${msg}`;
	if (level === "error" || level === "warn") console.error(line);
	else console.log(line);
}

function git(args, opts = {}) {
	return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", ...opts });
}

// Held while Pi is writing runtime/*.js so the supervisor's file watcher
// doesn't kill the bot mid-write and reload a half-saved file with a
// SyntaxError. See 2026-05-26 incident.
function acquireLock() {
	fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
	fs.writeFileSync(LOCK_FILE, String(process.pid));
}
function releaseLock() {
	try {
		const pid = Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
		if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
	} catch {}
}
process.on("exit", releaseLock);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { releaseLock(); process.exit(1); });

function exit(code, reason) {
	log(code === 0 ? "info" : "warn", `exit ${code}: ${reason}`);
	releaseLock();
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

// Each proposal may declare an editScope in its frontmatter so the patch is
// kept to the specific module(s) the operator (or the stuck detector) marked
// as relevant. Older proposals without editScope fall back to ["runtime/"],
// matching the historical default.
const scope = effectiveScope(parseEditScope(proposalText));
log("info", `edit scope: ${JSON.stringify(scope)}`);

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

acquireLock();
log("info", `acquired ${LOCK_FILE}`);

// Pick top-k similar existing skills so Pi can crib patterns instead of
// reinventing them (Mindcraft skill_library.getRelevantSkillDocs). Lazy
// import — skill registry pulls in mineflayer transitively which is
// expensive, and we don't need it on early-exit paths.
let relevantDocsBlock = "_(skill library unavailable)_";
try {
	const { renderRelevantDocs } = await import("../runtime/skill-library.js");
	relevantDocsBlock = renderRelevantDocs(proposalText, { k: 3 });
} catch (e) {
	log("warn", `skill-library render failed: ${e.message}`);
}

const scopeBullet = scope.map((p) => `   - \`${p}\``).join("\n");
const prompt = [
	"You are patching the pepa-pi-bot repo to address an automatically-detected failure.",
	"This is an UNATTENDED run — no operator will review your output before it lands on main.",
	"Be conservative. Prefer guard clauses and small surgical edits.",
	"",
	"## The proposal",
	"",
	proposalText,
	"",
	"## Relevant existing skills (top-3 by word overlap — use these as patterns)",
	"",
	relevantDocsBlock,
	"",
	"## Hard rules (non-negotiable)",
	"",
	"1. Touch ONLY files matching the edit scope below. Any other path will be rejected after you commit and the patch will be discarded:",
	scopeBullet,
	"2. You MAY add or update test files under `runtime/**/*.test.js` even if not listed above — tests for the fix are encouraged.",
	"3. Do not introduce npm dependencies. Do not modify `package.json`, `tui/`, `extensions/`, `scripts/`, `docs/`, `.env`, or anything in `state/`.",
	"4. Do not push, do not open a PR. Commit on the current branch only.",
	"5. Use a conventional commit message: `fix(runtime/<file>): <one-line summary>`.",
	"6. Run `npm test` mentally before committing — your patch must keep all existing tests green; the auto-patcher will run `npm test` and discard the patch if it fails.",
	"7. If you can't safely fix the issue, write a short comment in the relevant runtime file explaining why and stop — do NOT make a speculative change.",
	"8. Make exactly ONE commit. If you find multiple issues, focus on the one the proposal describes.",
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

pi.on("exit", async (code) => {
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

	// Verify the commit only touched files inside the declared edit scope.
	// Test files under runtime/**/*.test.js are always allowed — they're how
	// Pi proves the fix is safe and how the smoke gate below checks pass.
	const filesChanged = git(["diff", "--name-only", `${baseSha}..HEAD`]).stdout.trim().split("\n").filter(Boolean);
	const testFiles = filesChanged.filter((f) => /^runtime\/.*\.test\.js$/.test(f));
	const scopeWithTests = [...scope, ...testFiles];
	const validation = validateChangedFiles(filesChanged, scopeWithTests);
	if (!validation.ok) {
		log("error", `commit touched files outside scope ${JSON.stringify(scope)}: ${validation.outsideFiles.join(", ")} — discarding`);
		git(["checkout", "main"]);
		git(["branch", "-D", branch]);
		exit(2, "patch touched off-limits files");
	}

	// Pre-flight lint gate (Mindcraft coder._lintCode pattern, scripts/lint-patch.js).
	// Cheaper than npm test — catches parse errors, missing named imports,
	// and runSkill(id) where id isn't in the registry. Seconds, not 30s.
	log("info", "running lint pre-flight gate");
	const lint = await lintPatch({ repoRoot: REPO_ROOT, changedFiles: filesChanged });
	if (!lint.ok) {
		log("error", `lint FAILED — discarding:\n${lint.errors.join("\n")}`);
		git(["checkout", "main"]);
		git(["branch", "-D", branch]);
		exit(2, "patch failed lint");
	}
	log("info", "lint gate passed");

	// Smoke gate: run `npm test` on the patched branch BEFORE cherry-picking.
	// Anything that turns the suite red gets thrown away — even if Pi thinks
	// the change is correct.
	log("info", "running npm test smoke gate (timeout 5 min)");
	const smoke = spawnSync("npm", ["test"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: { ...process.env, CI: "1" },
		timeout: 5 * 60 * 1000,
	});
	if (smoke.status !== 0) {
		const tail = ((smoke.stdout || "") + "\n" + (smoke.stderr || "")).split("\n").slice(-10).join("\n");
		log("error", `npm test FAILED on patched branch — discarding\n${tail}`);
		git(["checkout", "main"]);
		git(["branch", "-D", branch]);
		exit(2, "patch failed smoke (npm test)");
	}
	log("info", "smoke gate passed");

	// v0.2.0 default: push branch + open PR. The operator approves the merge.
	const mode = (process.env.PEPA_AUTO_PATCH_MERGE || "pr").toLowerCase();
	if (mode === "cherry-pick") {
		// Legacy direct-to-main path (NOT recommended; bypasses operator review).
		git(["checkout", "main"]);
		const cherry = git(["cherry-pick", newHead]);
		if (cherry.status !== 0) {
			log("error", `cherry-pick failed: ${cherry.stderr}`);
			git(["cherry-pick", "--abort"]);
			exit(5, `cherry-pick conflict — see branch ${branch}`);
		}
		git(["branch", "-D", branch]);
		log("info", `patch applied to main as ${git(["rev-parse", "HEAD"]).stdout.trim().slice(0, 8)} (cherry-pick mode)`);
		exit(0, `applied ${filenameArg}`);
	}

	// Default: push the auto/<slug> branch to origin and open a PR.
	// Operator reviews + merges on GitHub.
	log("info", `pushing branch ${branch} to origin`);
	const push = git(["push", "-u", "origin", branch]);
	if (push.status !== 0) {
		log("error", `git push failed: ${push.stderr}`);
		git(["checkout", "main"]);
		exit(4, `push failed — branch left on disk: ${branch}`);
	}

	// Build a PR body from the proposal file + Pi's commit message.
	const proposalBody = (() => {
		try { return fs.readFileSync(proposal.path, "utf8"); } catch { return ""; }
	})();
	const piCommitMsg = git(["log", "-1", "--format=%B", newHead]).stdout.trim();
	const prTitle = `auto-patch: ${slug}`.slice(0, 70);
	const prBody = [
		"## Auto-generated patch",
		"",
		"This PR was produced by `scripts/auto-patch.js` from the proposal below.",
		"Tests passed before push. Review the diff and merge when you're happy.",
		"",
		"## Pi commit",
		"",
		"```",
		piCommitMsg.slice(0, 4000),
		"```",
		"",
		"## Proposal",
		"",
		proposalBody.slice(0, 8000),
	].join("\n");

	const prArgs = [
		"pr", "create",
		"--base", "main",
		"--head", branch,
		"--title", prTitle,
		"--body", prBody,
	];
	const pr = spawnSync("gh", prArgs, { cwd: REPO_ROOT, encoding: "utf8" });
	if (pr.status !== 0) {
		log("error", `gh pr create failed: ${pr.stderr || pr.stdout}`);
		git(["checkout", "main"]);
		exit(4, `pr create failed — branch ${branch} pushed but no PR`);
	}
	const prUrl = (pr.stdout || "").trim().split("\n").pop();
	log("info", `PR opened: ${prUrl}`);
	git(["checkout", "main"]);
	exit(0, `pr opened ${prUrl}`);
});
