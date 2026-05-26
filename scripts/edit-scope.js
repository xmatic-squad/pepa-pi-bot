// Helpers for auto-patch.js — kept separate so they can be unit-tested
// without spawning git/pi subprocesses.

const DEFAULT_SCOPE = ["runtime/"];

// Parse `editScope: [...]` out of a proposal markdown frontmatter block.
// Returns the array of path prefixes, or null if absent or malformed.
// Callers should fall back to DEFAULT_SCOPE when null.
export function parseEditScope(proposalText) {
	if (!proposalText) return null;
	const m = String(proposalText).match(/^---\n([\s\S]*?)\n---/);
	if (!m) return null;
	const scopeLine = m[1].split("\n").find((l) => l.trim().startsWith("editScope:"));
	if (!scopeLine) return null;
	const raw = scopeLine.slice(scopeLine.indexOf(":") + 1).trim();
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const cleaned = parsed
			.filter((p) => typeof p === "string" && p.length > 0)
			.map((p) => p.replace(/^\.?\/+/, "")); // strip leading ./ or /
		return cleaned.length > 0 ? cleaned : null;
	} catch {
		return null;
	}
}

// A changed file is in-scope when it matches any entry in `scope`.
// An entry ending with `/` is a directory prefix; anything else is an
// exact-match file path. The match is case-sensitive (we're on POSIX
// repos).
export function isFileInScope(file, scope) {
	for (const entry of scope) {
		if (!entry) continue;
		if (entry.endsWith("/")) {
			if (file === entry.slice(0, -1)) return true; // edge case
			if (file.startsWith(entry)) return true;
		} else if (file === entry) {
			return true;
		} else if (file.startsWith(`${entry}/`)) {
			// allow "runtime/skills" to cover "runtime/skills/foo.js"
			return true;
		}
	}
	return false;
}

export function validateChangedFiles(changedFiles, scope) {
	const effective = Array.isArray(scope) && scope.length ? scope : DEFAULT_SCOPE;
	const outside = (changedFiles ?? []).filter((f) => !isFileInScope(f, effective));
	return { ok: outside.length === 0, outsideFiles: outside, effectiveScope: effective };
}

export function effectiveScope(scope) {
	return Array.isArray(scope) && scope.length ? scope : DEFAULT_SCOPE.slice();
}

export const _internal = { DEFAULT_SCOPE };
