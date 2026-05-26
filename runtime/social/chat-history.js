// Per-player persistent chat history.
//
// Each player gets a JSONL file under state/<host>/chat/<player>.jsonl.
// Lines are { ts, dir: "in" | "out", text, snapshot? } and accumulate
// forever (with a 1000-line rolling cap per player, much higher than
// the in-memory chat-memory window so Pi can reference older banter
// across sessions — "помнишь, когда ты притащил жабу в чат?").
//
// Why per-player and not one global file: the runtime needs to give Pi
// the context of *this* dialog with *this* player without it being
// drowned by chatter from other players. Recall + privacy in one cut.
//
// Public API:
//   appendChat({player, dir, text, snapshot?}) — persist a line
//   recentForPlayer(player, n) — last n entries (oldest first)
//   knownPlayers() — list players we have any history with

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../config.js";

const CHAT_DIR = path.join(stateDir, "chat");
const MAX_LINES_PER_PLAYER = 1000;

function ensureDir() {
	try { fs.mkdirSync(CHAT_DIR, { recursive: true }); } catch {}
}

function safePlayer(name) {
	return String(name ?? "anon").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 64);
}

function pathFor(player) {
	return path.join(CHAT_DIR, `${safePlayer(player)}.jsonl`);
}

function readAll(player) {
	const fp = pathFor(player);
	if (!fs.existsSync(fp)) return [];
	const out = [];
	for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line)); } catch {}
	}
	return out;
}

function rotateIfNeeded(player) {
	const all = readAll(player);
	if (all.length <= MAX_LINES_PER_PLAYER) return;
	const keep = all.slice(-MAX_LINES_PER_PLAYER);
	fs.writeFileSync(pathFor(player), keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export function appendChat({ player, dir, text, snapshot, ts = Date.now() }) {
	if (!player || !text || (dir !== "in" && dir !== "out")) return;
	ensureDir();
	const slim = snapshot
		? {
			pos: snapshot.position ? { x: Math.round(snapshot.position.x), y: Math.round(snapshot.position.y), z: Math.round(snapshot.position.z) } : null,
			activeSkill: snapshot.activeSkill ?? null,
			milestone: snapshot.currentMilestone ?? null,
			isDay: snapshot.isDay ?? null,
		}
		: null;
	const entry = { ts, dir, text: String(text).slice(0, 500), ...(slim ? { snap: slim } : {}) };
	fs.appendFileSync(pathFor(player), JSON.stringify(entry) + "\n");
	if (Math.random() < 0.05) rotateIfNeeded(player); // amortise rotation
}

export function recentForPlayer(player, n = 10) {
	const all = readAll(player);
	return all.slice(-n);
}

export function knownPlayers() {
	ensureDir();
	try {
		return fs.readdirSync(CHAT_DIR)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.replace(/\.jsonl$/, ""));
	} catch {
		return [];
	}
}

// Render chat history as plain prompt-friendly lines.
// Example output:
//   [2026-05-26 19:07] halofourteen: Привет пепа что делаешь?
//   [2026-05-26 19:07] you: yo
export function renderHistory(player, n = 10, botName = "you") {
	const recent = recentForPlayer(player, n);
	return recent.map((e) => {
		const t = new Date(e.ts).toISOString().slice(0, 16).replace("T", " ");
		const who = e.dir === "in" ? player : botName;
		return `[${t}] ${who}: ${e.text}`;
	}).join("\n");
}

// Reset (tests only).
export function _resetChatHistory() {
	try {
		for (const f of fs.readdirSync(CHAT_DIR)) fs.unlinkSync(path.join(CHAT_DIR, f));
	} catch {}
}
