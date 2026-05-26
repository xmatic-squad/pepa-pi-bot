// Multi-agent conversation skeleton — inspired by Mindcraft
// mindserver_proxy.js but stripped to the minimum useful contract.
//
// A conversation is a named topic two or more bots subscribe to. While
// open, each tick a participant may append a turn — `{from, position,
// intent, ts}` — and read the last N turns from every peer. The
// transport today is a JSONL file under `state/<host>/conversations/`;
// the Unix socket variant can be bolted on later without changing the
// caller API.
//
// Why file-based: pepa already runs multiple bots from the same repo
// using different host directories under `state/`. A shared JSONL is
// the cheapest cross-process channel that survives restarts and the
// supervisor's hot-reload. No daemon, no port allocation.
//
// Public API (intentionally small):
//   openConversation(topic)      → handle { append, recent, close }
//   listConversations()          → ["topic1", "topic2"]
//   peekConversation(topic, n)   → last n turns, oldest first

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../config.js";

const CONV_DIR = path.join(stateDir, "conversations");
const MAX_TURNS_KEEP = 200;

function ensureDir() {
	try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch {}
}

function pathFor(topic) {
	const safe = String(topic).replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 64);
	return path.join(CONV_DIR, `${safe}.jsonl`);
}

function readAll(topic) {
	const fp = pathFor(topic);
	if (!fs.existsSync(fp)) return [];
	const text = fs.readFileSync(fp, "utf8");
	const out = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line)); } catch {}
	}
	return out;
}

function rotateIfNeeded(topic) {
	const all = readAll(topic);
	if (all.length <= MAX_TURNS_KEEP) return;
	const keep = all.slice(-MAX_TURNS_KEEP);
	fs.writeFileSync(pathFor(topic), keep.map((t) => JSON.stringify(t)).join("\n") + "\n");
}

export function openConversation(topic, { speaker } = {}) {
	if (!topic) throw new Error("openConversation: topic required");
	if (!speaker) throw new Error("openConversation: speaker required");
	ensureDir();
	const fp = pathFor(topic);
	// Seed the file with an `open` event so peers can discover the topic.
	if (!fs.existsSync(fp)) {
		fs.appendFileSync(fp, JSON.stringify({ ts: Date.now(), from: speaker, kind: "open", topic }) + "\n");
	}
	const handle = {
		topic,
		speaker,
		append({ position, intent, text } = {}) {
			const turn = {
				ts: Date.now(),
				from: speaker,
				kind: "turn",
				position: position ?? null,
				intent: intent ?? null,
				text: text ?? null,
			};
			fs.appendFileSync(fp, JSON.stringify(turn) + "\n");
			rotateIfNeeded(topic);
			return turn;
		},
		recent({ n = 10, excludeSelf = false } = {}) {
			const all = readAll(topic);
			const turns = excludeSelf ? all.filter((t) => t.from !== speaker) : all;
			return turns.slice(-n);
		},
		peers() {
			const seen = new Set();
			for (const t of readAll(topic)) if (t.from) seen.add(t.from);
			return Array.from(seen);
		},
		close() {
			fs.appendFileSync(fp, JSON.stringify({ ts: Date.now(), from: speaker, kind: "close" }) + "\n");
		},
	};
	return handle;
}

export function listConversations() {
	ensureDir();
	try {
		return fs.readdirSync(CONV_DIR)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.replace(/\.jsonl$/, ""));
	} catch {
		return [];
	}
}

export function peekConversation(topic, n = 10) {
	const all = readAll(topic);
	return all.slice(-n);
}

// Test hook — wipes the directory. Don't call in production.
export function _resetConversations() {
	try {
		for (const f of fs.readdirSync(CONV_DIR)) fs.unlinkSync(path.join(CONV_DIR, f));
	} catch {}
}
