// Per-server state on disk. Two surfaces:
//   - current-task.json — what action is in flight (or last finished).
//     Used as the resume anchor across restarts. Atomically rewritten via
//     write-rename to avoid torn reads.
//   - diary/YYYY-MM-DD.md — append-only daily journal. One line per
//     meaningful milestone (death, escalation, first attack on a new mob
//     type, sleep success, etc.). The reflex layer decides what counts.
//
// All writes are sync — these files are tiny and per-tick at most.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./config.js";

const CURRENT_TASK_PATH = path.join(stateDir, "current-task.json");
const DIARY_DIR = path.join(stateDir, "diary");
const PROPOSALS_DIR = path.join(stateDir, "proposals");
const PROPOSALS_APPROVED_DIR = path.join(PROPOSALS_DIR, "approved");

fs.mkdirSync(DIARY_DIR, { recursive: true });
fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
fs.mkdirSync(PROPOSALS_APPROVED_DIR, { recursive: true });

// ---- current-task ----------------------------------------------------------

export function readCurrentTask() {
	try {
		const raw = fs.readFileSync(CURRENT_TASK_PATH, "utf8").trim();
		if (!raw) return null;
		return JSON.parse(raw);
	} catch (e) {
		if (e.code === "ENOENT") return null;
		// corrupt file — treat as no task
		return null;
	}
}

function writeAtomic(filePath, content) {
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, filePath);
}

export function writeCurrentTask(task) {
	if (!task) {
		clearCurrentTask();
		return;
	}
	writeAtomic(
		CURRENT_TASK_PATH,
		JSON.stringify({ ts: new Date().toISOString(), ...task }, null, 2),
	);
}

export function clearCurrentTask() {
	try {
		writeAtomic(CURRENT_TASK_PATH, "{}\n");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
}

// ---- diary -----------------------------------------------------------------

function diaryPath(date = new Date()) {
	const stamp = date.toISOString().slice(0, 10);
	return path.join(DIARY_DIR, `${stamp}.md`);
}

export function appendDiary(text) {
	const stamp = new Date().toISOString().slice(11, 19);
	const line = `${stamp} ${text}\n`;
	fs.appendFileSync(diaryPath(), line);
}

// Tail N most-recent diary lines from today's file. Returns the most-recent
// line (or null if the day's diary is empty / missing). Cheap enough to
// call from the chat reply path.
export function readDiaryTail(n = 1) {
	try {
		const raw = fs.readFileSync(diaryPath(), "utf8");
		const lines = raw.split("\n").filter((l) => l.trim());
		if (lines.length === 0) return null;
		return lines.slice(-n).join("\n");
	} catch (e) {
		if (e.code === "ENOENT") return null;
		return null;
	}
}

// ---- escalations -----------------------------------------------------------
//
// Per-server JSON-lines log of moments the bot chose NOT to act because the
// request looked unsafe or out of scope. Read by future operator UIs (TUI
// surfaces the count) and by the chat handler when Phase 5 social classifies
// an inbound message as UNSAFE_REQUEST.

const ESCALATIONS_PATH = path.join(stateDir, "escalations.jsonl");

export function writeEscalation({ from, request, whyUnsure, wouldHave }) {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		from,
		request,
		why_unsure: whyUnsure,
		would_have: wouldHave,
	}) + "\n";
	fs.appendFileSync(ESCALATIONS_PATH, line);
}

export function listEscalations({ limit = 50 } = {}) {
	try {
		const raw = fs.readFileSync(ESCALATIONS_PATH, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim());
		const slice = lines.slice(-limit);
		return slice
			.map((l) => {
				try { return JSON.parse(l); } catch { return null; }
			})
			.filter(Boolean);
	} catch (e) {
		if (e.code === "ENOENT") return [];
		return [];
	}
}

// ---- proposals -------------------------------------------------------------

function slugify(s) {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

export function writeProposal({ kind, summary, body }) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filename = `${stamp}-${slugify(kind)}.md`;
	const filePath = path.join(PROPOSALS_DIR, filename);
	const content = [
		"---",
		`kind: ${kind}`,
		`ts: ${new Date().toISOString()}`,
		`summary: ${JSON.stringify(summary)}`,
		"approved: false",
		"---",
		"",
		body,
		"",
	].join("\n");
	fs.writeFileSync(filePath, content);
	return { filePath, filename };
}

export function listProposals({ approved = false } = {}) {
	const dir = approved ? PROPOSALS_APPROVED_DIR : PROPOSALS_DIR;
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

export function readProposal(filename, { approved = false } = {}) {
	const dir = approved ? PROPOSALS_APPROVED_DIR : PROPOSALS_DIR;
	const filePath = path.join(dir, filename);
	return fs.readFileSync(filePath, "utf8");
}

export function approveProposal(filename) {
	const src = path.join(PROPOSALS_DIR, filename);
	const dst = path.join(PROPOSALS_APPROVED_DIR, filename);
	const content = fs.readFileSync(src, "utf8").replace(/^approved: false/m, "approved: true");
	fs.writeFileSync(dst, content);
	fs.unlinkSync(src);
	return dst;
}

export const paths = Object.freeze({
	currentTask: CURRENT_TASK_PATH,
	diary: DIARY_DIR,
	proposals: PROPOSALS_DIR,
	proposalsApproved: PROPOSALS_APPROVED_DIR,
});
