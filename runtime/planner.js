// LLM planner: every PLANNER_INTERVAL_MS (15 min) reads goal.md +
// state/<host>/plan.md + a slim snapshot and asks Pi to update plan.md
// with the current set of milestones. Reflex layer treats plan.md as
// advisory hints (we don't auto-execute LLM-written code from here).
//
// The plan is markdown for two reasons:
//   1. It's small enough to put in a prompt and read back from Pi.
//   2. The operator can edit it directly with $EDITOR if Pi drifts.
//
// We don't block on this. spawnPlanner runs as a detached promise; if Pi
// is slow or down, the reflex layer keeps doing what it was doing.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { stateDir } from "./config.js";
import { info, warn } from "./log.js";

const GOAL_PATH = path.join(stateDir, "goal.md");
const PLAN_PATH = path.join(stateDir, "plan.md");

const PLANNER_INTERVAL_MS = 15 * 60_000;
const PLANNER_TIMEOUT_MS = 5 * 60_000;
const MAX_PLAN_BYTES = 16_000;

let planTimer = null;
let planInFlight = false;

function readOr(file, fallback = "") {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (e) {
		if (e.code === "ENOENT") return fallback;
		throw e;
	}
}

function buildPrompt({ goal, plan, snapshot }) {
	const slim = snapshot
		? {
				position: snapshot.position,
				health: snapshot.health,
				food: snapshot.food,
				isDay: snapshot.isDay,
				inventory: snapshot.inventory,
				dimension: snapshot.dimension,
			}
		: null;
	return [
		"You are the long-horizon PLANNER for an autonomous Minecraft farmer bot.",
		"",
		"Read the goal.md, the current plan.md (if any), and the bot's latest snapshot.",
		"Output an UPDATED plan.md to stdout. No markdown code fences, no preamble —",
		"the entire stdout will be written verbatim to plan.md.",
		"",
		"## Constraints",
		"",
		"- Format: numbered milestones, each on one short line. Optional sub-bullets allowed.",
		"- Each milestone must be concrete, measurable, and within reach of the current",
		"  inventory + reflex capabilities (chop, craft planks/sticks/wooden tools,",
		"  wander, defend, eat, sleep, goto, place a single block).",
		"- Mark completed milestones with a leading '✓ '. Keep them in the list as history.",
		"- The first uncompleted milestone is the NEXT thing the bot will work on.",
		"- Cap the file at 80 lines / ~3 KB. If older milestones aren't useful to keep,",
		"  drop them.",
		"- Do NOT propose anything outside the overworld; no nether, no end, no PvP.",
		"- Do NOT propose anything that requires OP, /commands, or external services.",
		"- If the goal already looks satisfied, write the next maintenance cycle.",
		"",
		"## goal.md",
		"",
		goal || "(empty — the operator has not seeded a long-term goal yet)",
		"",
		"## Current plan.md",
		"",
		plan || "(no plan yet — start from scratch)",
		"",
		"## Snapshot (slim)",
		"",
		"```json",
		JSON.stringify(slim, null, 2),
		"```",
		"",
		"Now output the new plan.md content. Plain markdown only.",
	].join("\n");
}

function tick(getSnapshot) {
	if (planInFlight) return;
	const goal = readOr(GOAL_PATH);
	if (!goal.trim()) {
		// Nothing to plan toward. Skip silently.
		return;
	}
	const plan = readOr(PLAN_PATH);
	const snapshot = getSnapshot();
	planInFlight = true;
	info("planner", "asking Pi for an updated plan.md");

	const prompt = buildPrompt({ goal, plan, snapshot });
	const child = spawn("pi", ["-p", prompt], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, CI: "1" },
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (c) => {
		stdout += c.toString();
		if (stdout.length > MAX_PLAN_BYTES * 2) {
			// Pi went off — truncate further reads.
			stdout = stdout.slice(0, MAX_PLAN_BYTES * 2);
		}
	});
	child.stderr.on("data", (c) => {
		stderr += c.toString();
	});

	const killTimer = setTimeout(() => {
		warn("planner", "Pi timed out — killing");
		child.kill("SIGTERM");
	}, PLANNER_TIMEOUT_MS);

	child.on("exit", (code) => {
		clearTimeout(killTimer);
		planInFlight = false;
		if (code !== 0) {
			warn("planner", `pi exited ${code}: ${stderr.split("\n")[0]}`);
			return;
		}
		const cleaned = stripCodeFences(stdout).trim();
		if (!cleaned) {
			warn("planner", "pi produced empty output");
			return;
		}
		if (cleaned.length > MAX_PLAN_BYTES) {
			warn("planner", `plan too large (${cleaned.length}B) — truncating`);
		}
		try {
			fs.writeFileSync(PLAN_PATH, cleaned.slice(0, MAX_PLAN_BYTES));
			info("planner", `plan.md updated (${cleaned.length}B)`);
		} catch (e) {
			warn("planner", `could not write plan.md: ${e.message}`);
		}
	});
}

function stripCodeFences(s) {
	// Pi sometimes wraps the entire output in ```markdown … ``` even when
	// told not to. Strip outer fences if present.
	const trimmed = s.trim();
	const m = trimmed.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
	return m ? m[1] : trimmed;
}

export function startPlanner(getSnapshot) {
	if (planTimer) return;
	info("planner", `scheduling every ${PLANNER_INTERVAL_MS / 60_000} min`);
	// Run once on startup so we don't wait 15 min for the first plan.
	setTimeout(() => tick(getSnapshot), 30_000);
	planTimer = setInterval(() => tick(getSnapshot), PLANNER_INTERVAL_MS);
}

export function stopPlanner() {
	if (planTimer) clearInterval(planTimer);
	planTimer = null;
}

export function readCurrentPlan() {
	return readOr(PLAN_PATH);
}
