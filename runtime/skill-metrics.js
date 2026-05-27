// Per-skill ok/fail counters. Persisted under state/<host>/ so the bot's
// next run and auto-improvement prompts can learn from prior attempts,
// not only the current process lifetime.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./config.js";

const METRICS_PATH = path.join(stateDir, "skill-metrics.json");

function loadMetrics() {
	const counts = new Map();
	try {
		const raw = fs.readFileSync(METRICS_PATH, "utf8");
		const parsed = JSON.parse(raw);
		for (const [id, m] of Object.entries(parsed ?? {})) {
			counts.set(id, {
				ok: Number(m.ok ?? 0),
				fail: Number(m.fail ?? 0),
				lastTs: Number(m.lastTs ?? 0),
				lastCode: m.lastCode ?? null,
				lastDurationMs: Number(m.lastDurationMs ?? 0),
				totalDurationMs: Number(m.totalDurationMs ?? 0),
			});
		}
	} catch {}
	return counts;
}

function saveMetrics(counts) {
	try {
		fs.mkdirSync(stateDir, { recursive: true });
		const out = {};
		for (const [id, m] of counts) out[id] = { ...m };
		const tmp = `${METRICS_PATH}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
		fs.renameSync(tmp, METRICS_PATH);
	} catch {}
}

export function createSkillMetrics({ persist = true } = {}) {
	const counts = persist ? loadMetrics() : new Map(); // id → { ok, fail, lastTs }

	function record(id, ok, { code = null, durationMs = 0 } = {}) {
		const cur = counts.get(id) ?? { ok: 0, fail: 0, lastTs: 0, lastCode: null, lastDurationMs: 0, totalDurationMs: 0 };
		if (ok) cur.ok++;
		else cur.fail++;
		cur.lastTs = Date.now();
		cur.lastCode = code ?? cur.lastCode ?? null;
		cur.lastDurationMs = Math.max(0, Math.round(durationMs || 0));
		cur.totalDurationMs += cur.lastDurationMs;
		counts.set(id, cur);
		if (persist) saveMetrics(counts);
	}

	function snapshot() {
		const out = {};
		for (const [id, m] of counts) {
			const total = (m.ok ?? 0) + (m.fail ?? 0);
			out[id] = {
				...m,
				avgDurationMs: total > 0 ? Math.round((m.totalDurationMs ?? 0) / total) : 0,
			};
		}
		return out;
	}

	function reset() {
		counts.clear();
		if (persist) {
			try { fs.unlinkSync(METRICS_PATH); } catch {}
		}
	}

	return { record, snapshot, reset };
}
