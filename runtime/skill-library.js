// Skill-library retrieval — adapted from Mindcraft skill_library.js.
//
// Each registered skill exposes a doc string (id, title, top-of-file
// jsdoc comment when present). When auto-patch.js builds the prompt for
// Pi, we rank docs by overlap with the proposal text and include the
// top-k similar skills so Pi can crib patterns from working code.
//
// We deliberately use word-overlap (Mindcraft's fallback) instead of
// embeddings — zero deps, no network, deterministic. If we later want
// embeddings the API stays the same.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listSkills } from "./skills/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pull the leading jsdoc-style comment block out of a skill source file.
// Mineflayer-style skill files start with a `// ... // ...` comment header
// that already documents intent; we treat that as the doc string.
function extractHeaderComment(src) {
	if (!src) return "";
	const lines = src.split("\n");
	const out = [];
	for (const line of lines) {
		const t = line.trim();
		if (t.startsWith("//")) {
			out.push(t.replace(/^\/\/\s?/, ""));
		} else if (out.length > 0) {
			break;
		} else if (t === "") {
			continue;
		} else {
			break;
		}
	}
	return out.join(" ").slice(0, 800);
}

function skillFilePath(id) {
	const slug = id.replace(/\./g, "-");
	const candidates = [
		path.join(__dirname, "skills", `${slug}.js`),
		path.join(__dirname, "skills", `${slug.replace(/-/g, "_")}.js`),
	];
	for (const p of candidates) if (fs.existsSync(p)) return p;
	return null;
}

let cache = null;
function loadDocs() {
	if (cache) return cache;
	const entries = [];
	for (const sk of listSkills()) {
		const fp = skillFilePath(sk.id);
		let header = "";
		if (fp) {
			try { header = extractHeaderComment(fs.readFileSync(fp, "utf8")); } catch {}
		}
		entries.push({ id: sk.id, title: sk.title, doc: `${sk.id} — ${sk.title}\n${header}` });
	}
	cache = entries;
	return cache;
}

// Word-overlap scoring identical in spirit to Mindcraft's
// wordOverlapScore: lower-case, split on non-word, count overlap.
const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "for", "in", "on", "with", "is", "are", "was", "be", "if", "we", "you", "i", "it", "that", "this", "by", "from", "at", "as", "but", "not"]);
function tokenise(s) {
	return new Set(
		String(s || "")
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter((w) => w.length > 2 && !STOP.has(w)),
	);
}
export function wordOverlapScore(a, b) {
	const A = tokenise(a);
	const B = tokenise(b);
	if (A.size === 0 || B.size === 0) return 0;
	let inter = 0;
	for (const w of A) if (B.has(w)) inter++;
	return inter / Math.sqrt(A.size * B.size);
}

export function relevantSkillDocs(query, { k = 3, alwaysShow = [] } = {}) {
	const docs = loadDocs();
	const scored = docs.map((e) => ({ ...e, score: wordOverlapScore(query, e.doc) }));
	scored.sort((a, b) => b.score - a.score);
	const picked = new Map();
	for (const id of alwaysShow) {
		const hit = docs.find((d) => d.id === id);
		if (hit) picked.set(hit.id, hit);
	}
	for (const s of scored.slice(0, k)) picked.set(s.id, s);
	return Array.from(picked.values());
}

// Render the relevant-docs block for embedding into a Pi prompt.
export function renderRelevantDocs(query, opts) {
	const picked = relevantSkillDocs(query, opts);
	if (picked.length === 0) return "_(no skill docs registered)_";
	return picked
		.map((e) => `### \`${e.id}\` — ${e.title}\n${e.doc}`)
		.join("\n\n");
}

// Reset for tests.
export function _resetCache() { cache = null; }
