// Pure, ink-free helpers for the monitor header.
//
// bot.js stamps a rich observability bundle onto every STATUS snapshot
// (runtimeState, lastReflex.name, activeSkill, noProgressReason, reflexPaused)
// and the GoalManager annotates contract.suggestedSkill.blockedBy — but none
// of it was rendered, so the operator could not answer "what is the bot doing,
// why, and what is blocked?" from the screen. These helpers assemble that into
// colour-tagged segments. Kept in a plain .js module (no React/ink import) so
// `node --test` can unit-test the formatting without booting the TUI.
//
// A "segment" is { text, color?, dimColor?, bold? }. The monitor maps each to
// an <ink Text>; tests join `.text` and assert on substrings + segment colour.

const STATE_COLORS = Object.freeze({
	emergency: "red",
	recovering: "yellow",
	working: "green",
	planning: "magenta",
	social: "cyan",
	idle: "gray",
});

// computeState can return any of the STATES strings; unknown/new states render
// in a neutral colour rather than being blanked out.
export function stateColor(state) {
	if (!state) return "gray";
	return STATE_COLORS[String(state).toLowerCase()] ?? "white";
}

// blockedBy is an array of { item, min, have } | { tool } OBJECTS (from
// goal-manager.js via skill-graph.prerequisitesMet) — NOT strings. Map to the
// missing names so we never render "[object Object]". Returns null when there
// is nothing blocked.
export function formatBlockedBy(blockedBy) {
	if (!Array.isArray(blockedBy) || blockedBy.length === 0) return null;
	const names = blockedBy
		.map((b) => {
			const name = b?.item ?? b?.tool;
			if (!name) return null;
			return b?.min && b.min > 1 ? `${name}×${b.min}` : name;
		})
		.filter(Boolean);
	return names.length ? names.join("+") : null;
}

// Build the "what / why / blocked / stalled" status line for the header.
// Reads only fields already present on the broadcast snapshot.
export function formatStatusSegments(snapshot = {}) {
	const segs = [];
	const push = (text, opts = {}) => {
		if (text != null && text !== "") segs.push({ text, ...opts });
	};

	const state = snapshot.runtimeState;
	if (state) push(String(state), { bold: true, color: stateColor(state) });

	if (snapshot.reflexPaused === true) push(" PAUSED", { bold: true, color: "red" });

	// why — which rail fired this tick (mode:…, curriculum, defend, …)
	const why = snapshot.lastReflex?.name;
	if (why) {
		push(" via ", { dimColor: true });
		push(String(why), { color: "white" });
	}

	// doing — the skill currently/last dispatched
	const doing = snapshot.activeSkill;
	if (doing) {
		push(" · ", { dimColor: true });
		push(String(doing), { color: "cyan" });
	}

	// blocked — the suggested skill cannot run because a prerequisite is
	// missing (e.g. craft.torch needs coal). This is the one that made the
	// M6-torch/coal stall invisible.
	const sg = snapshot.contract?.suggestedSkill;
	const blocked = formatBlockedBy(sg?.blockedBy);
	if (blocked) {
		push(" · ", { dimColor: true });
		if (sg?.skillId) push(String(sg.skillId), { color: "red" });
		push(" needs ", { dimColor: true });
		push(blocked, { color: "red", bold: true });
	}

	// urgent preemption (food jumping the contract queue)
	const reason = snapshot.contract?.reason;
	if (typeof reason === "string" && reason.startsWith("urgent")) {
		push(" · ", { dimColor: true });
		push(reason, { color: "yellow" });
	}

	// stalled — no observable world change for a while
	const np = snapshot.noProgressReason;
	if (np) {
		push(" · stalled:", { dimColor: true });
		push(String(np), { color: "yellow" });
	}

	return segs;
}

// Convenience for tests / plain-text surfaces.
export function statusText(snapshot) {
	return formatStatusSegments(snapshot)
		.map((s) => s.text)
		.join("");
}
