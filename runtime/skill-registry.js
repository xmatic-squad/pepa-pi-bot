// Single source of truth for "what skill ids are real" — exported separately
// from skills/index.js so coach/advice.js, coach/postmortem.js, coach/reflect.js,
// and coach/fast-advisor.js can all consult the SAME live registry without
// circular imports through runSkill.
//
// Why this exists: in v0.2.x Pi (the LLM coach) routinely fabricated
// skill ids that never existed — "relocate.surface", "choose.safe.surface",
// "survive.shelter", "gather.visible_log". Of 47 Pi-extracted lessons,
// 0 were ever applied because normalisePreferSkill() couldn't map them
// to anything real. The fix is two-pronged: (a) hand Pi the real registry
// in its system prompt so it doesn't have to guess; (b) reject anything
// not in the registry at the consult() boundary.

import { listSkills } from "./skills/index.js";

let _cache = null;

function rebuild() {
	const all = listSkills();
	const byId = new Map();
	const byNamespace = new Map();
	for (const s of all) {
		byId.set(s.id, s);
		const ns = s.id.split(".")[0] || "misc";
		if (!byNamespace.has(ns)) byNamespace.set(ns, []);
		byNamespace.get(ns).push(s);
	}
	_cache = { all, byId, byNamespace };
	return _cache;
}

function get() { return _cache ?? rebuild(); }

export function listSkillIds() {
	return Array.from(get().byId.keys());
}

export function isRegistered(id) {
	if (!id || typeof id !== "string") return false;
	return get().byId.has(id);
}

export function describeSkill(id) {
	return get().byId.get(id) ?? null;
}

// Human-readable block to drop into LLM system prompts. Groups by
// namespace, lists "id — title (timeoutMs)". Capped at ~2KB to stay
// well within the model's instruction window.
export function skillRegistryPrompt({ limit = 2000 } = {}) {
	const { byNamespace } = get();
	const namespaces = Array.from(byNamespace.keys()).sort();
	const lines = ["Valid skill ids (USE ONLY THESE for avoid_skill / prefer_skill):"];
	for (const ns of namespaces) {
		const skills = byNamespace.get(ns).sort((a, b) => a.id.localeCompare(b.id));
		lines.push(`  ${ns}:`);
		for (const s of skills) {
			lines.push(`    - ${s.id} — ${s.title ?? s.id}`);
		}
	}
	lines.push("");
	lines.push("If no listed skill fits, set the field to null. NEVER invent new ids.");
	const text = lines.join("\n");
	return text.length > limit ? text.slice(0, limit - 4) + "\n..." : text;
}

// For tests / hot-reload scenarios.
export function _resetForTest() { _cache = null; }
