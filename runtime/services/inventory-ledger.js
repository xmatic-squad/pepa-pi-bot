// InventoryLedger (L1 service) — diff-based "did I actually get it" verifier.
//
// The proximate cause of the live `no_drop` symptom (research §A.4, QW2): the
// bot has no reliable signal that a pickup happened. mineflayer's
// `playerCollect` event is unreliable (fires for the wrong entity when other
// droppers tick nearby — mineflayer #1171) and item entities visually vanish
// past ~16 blocks (Minecraft Wiki, Item entity). The only ground truth is the
// inventory itself.
//
// This ledger snapshots `bot.inventory.items()` over time and answers two
// questions deterministically:
//   - count(name)               -> current count of an exact item
//   - total(matcher)            -> sum of counts for items matching a predicate
//   - gainedSince(baseline, m)  -> net positive gain of matching items vs a baseline
//   - acquired(matcher, sinceTs)-> same, but baselined to a wall-clock timestamp
//
// Skills verify success with `const base = ledger.mark(); ...; ledger.update(bot);
// const got = ledger.gainedSince(base, isFood)` instead of trusting events.
//
// Pure w.r.t. the runtime: it only reads inventory. update() is driven once
// per tick from bot.js, and a skill may call update(bot) itself to force a
// fresh read before checking a delta (independent of tick cadence).

function itemsToCounts(items) {
	const m = new Map();
	for (const it of items ?? []) {
		if (!it?.name) continue;
		m.set(it.name, (m.get(it.name) ?? 0) + (it.count ?? 0));
	}
	return m;
}

function countsFromBot(bot) {
	try {
		return itemsToCounts(bot?.inventory?.items?.() ?? []);
	} catch {
		return new Map();
	}
}

function matchFn(matcher) {
	if (typeof matcher === "function") return matcher;
	if (matcher instanceof RegExp) return (n) => matcher.test(n);
	if (typeof matcher === "string") return (n) => n === matcher;
	if (Array.isArray(matcher)) {
		const set = new Set(matcher);
		return (n) => set.has(n);
	}
	if (matcher instanceof Set) return (n) => matcher.has(n);
	return () => true;
}

export function createInventoryLedger({ historyMs = 6 * 60_000, maxSnapshots = 240 } = {}) {
	let history = []; // [{ ts, counts: Map<string,number> }], oldest→newest
	let current = new Map();

	// Record a snapshot now. Accepts a bot or a raw items array (for tests).
	function update(botOrItems, now = Date.now()) {
		current = Array.isArray(botOrItems) ? itemsToCounts(botOrItems) : countsFromBot(botOrItems);
		history.push({ ts: now, counts: current });
		const cutoff = now - historyMs;
		while (history.length > 1 && (history[0].ts < cutoff || history.length > maxSnapshots)) {
			history.shift();
		}
		return current;
	}

	function count(name) {
		return current.get(name) ?? 0;
	}

	function total(matcher) {
		const f = matchFn(matcher);
		let sum = 0;
		for (const [name, c] of current) if (f(name)) sum += c;
		return sum;
	}

	// A baseline is just a frozen copy of the counts at a point in time.
	function mark() {
		return new Map(current);
	}

	function gainedSince(baseline, matcher) {
		const f = matchFn(matcher);
		const base = baseline ?? new Map();
		let gained = 0;
		for (const [name, c] of current) {
			if (!f(name)) continue;
			const before = base.get(name) ?? 0;
			if (c > before) gained += c - before;
		}
		return gained;
	}

	// The newest recorded snapshot whose ts is <= sinceTs (i.e. the world as it
	// was at that moment). Empty map if we have no history that old.
	function baselineAt(sinceTs) {
		let chosen = null;
		for (const h of history) {
			if (h.ts <= sinceTs) chosen = h;
			else break;
		}
		return chosen ? new Map(chosen.counts) : new Map();
	}

	function acquired(matcher, sinceTs) {
		return gainedSince(baselineAt(sinceTs), matcher);
	}

	// Full signed diff {name: change} vs the snapshot at sinceTs. Used for
	// worldDelta validation and diary narration.
	function delta(sinceTs) {
		const base = baselineAt(sinceTs);
		const out = {};
		const names = new Set([...base.keys(), ...current.keys()]);
		for (const name of names) {
			const d = (current.get(name) ?? 0) - (base.get(name) ?? 0);
			if (d !== 0) out[name] = d;
		}
		return out;
	}

	function snapshot() {
		return new Map(current);
	}

	return {
		update,
		count,
		total,
		mark,
		gainedSince,
		acquired,
		baselineAt,
		delta,
		snapshot,
		_history: () => history,
	};
}

export const _internal = { itemsToCounts, matchFn };
