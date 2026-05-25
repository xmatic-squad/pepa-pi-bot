// Per-skill ok/fail counters. Aggregated for the lifetime of the bot
// process (best-effort persistence is left for a future iteration —
// today's counters reset on restart, which keeps the data store
// simple while still being useful for incident bodies and the TUI).

export function createSkillMetrics() {
	const counts = new Map(); // id → { ok, fail, lastTs }

	function record(id, ok) {
		const cur = counts.get(id) ?? { ok: 0, fail: 0, lastTs: 0 };
		if (ok) cur.ok++;
		else cur.fail++;
		cur.lastTs = Date.now();
		counts.set(id, cur);
	}

	function snapshot() {
		const out = {};
		for (const [id, m] of counts) out[id] = { ...m };
		return out;
	}

	function reset() {
		counts.clear();
	}

	return { record, snapshot, reset };
}
