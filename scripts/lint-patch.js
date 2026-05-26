// Pre-flight lint for auto-patch — adapted from Mindcraft's coder._lintCode.
//
// Runs AFTER Pi commits to the auto/* branch but BEFORE `npm test`. Cheap
// checks that catch the most common "Pi hallucinated an API" failures:
//
//   1. node --check each changed runtime/*.js — parse errors caught
//      without spinning up the supervisor.
//   2. dynamic import — surfaces "Named export X not found" before tests
//      that don't directly import the file would have caught it.
//   3. runSkill("X.y", ...) calls — the id must exist in the live skill
//      registry. Pi sometimes invents skill ids that look plausible.
//
// Returns { ok: true } or { ok: false, errors: string[] }. The auto-patch
// caller decides whether to discard the patch. We deliberately exit with
// a list (not fail-fast) so a single discard reason is enough for Pi to
// understand on the next attempt.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function parseCheck(absPath) {
	const res = spawnSync(process.execPath, ["--check", absPath], { encoding: "utf8" });
	return res.status === 0
		? { ok: true }
		: { ok: false, error: `parse: ${res.stderr.split("\n").slice(0, 2).join(" ")}` };
}

export function importCheck(absPath) {
	const code = `import("${absPath.replace(/"/g, '\\"')}").then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})`;
	const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 15_000 });
	return res.status === 0
		? { ok: true }
		: { ok: false, error: `import: ${(res.stderr || res.stdout || "").split("\n")[0].slice(0, 200)}` };
}

// Extract runSkill("...") / getSkill("...") string-literal arguments.
// Multi-line tolerated; backticks tolerated; templating not (Pi must
// pass a literal id at lint time, otherwise we can't verify).
const SKILL_CALL_RE = /(?:runSkill|getSkill)\s*\(\s*["'`]([a-zA-Z0-9_.-]+)["'`]/g;

export function extractSkillCalls(code) {
	const seen = new Set();
	let m;
	SKILL_CALL_RE.lastIndex = 0;
	while ((m = SKILL_CALL_RE.exec(code)) !== null) seen.add(m[1]);
	return Array.from(seen);
}

export async function loadRegisteredSkillIds(repoRoot) {
	const skillsIndex = path.join(repoRoot, "runtime", "skills", "index.js");
	const mod = await import(skillsIndex);
	if (typeof mod.listSkills === "function") return new Set(mod.listSkills().map((s) => s.id));
	return new Set();
}

export async function lintPatch({ repoRoot, changedFiles }) {
	const errors = [];
	const runtimeFiles = (changedFiles || []).filter((f) => /^runtime\/.*\.js$/.test(f) && !f.endsWith(".test.js"));
	for (const rel of runtimeFiles) {
		const abs = path.join(repoRoot, rel);
		if (!fs.existsSync(abs)) continue;
		const pc = parseCheck(abs);
		if (!pc.ok) errors.push(`${rel}: ${pc.error}`);
	}
	// import-check only after parse-check is clean so we report the first
	// failure clearly. import-check spins a fresh node, so we limit it to
	// the actually-touched runtime files.
	if (errors.length === 0) {
		for (const rel of runtimeFiles) {
			const abs = path.join(repoRoot, rel);
			if (!fs.existsSync(abs)) continue;
			const ic = importCheck(abs);
			if (!ic.ok) errors.push(`${rel}: ${ic.error}`);
		}
	}
	// runSkill id check — only meaningful if imports work.
	if (errors.length === 0) {
		let known = new Set();
		try { known = await loadRegisteredSkillIds(repoRoot); }
		catch (e) { return { ok: false, errors: [`skills index load failed: ${e.message}`] }; }
		for (const rel of runtimeFiles) {
			const abs = path.join(repoRoot, rel);
			if (!fs.existsSync(abs)) continue;
			const code = fs.readFileSync(abs, "utf8");
			for (const id of extractSkillCalls(code)) {
				if (!known.has(id) && !id.startsWith("diag.") && !id.startsWith("test.")) {
					errors.push(`${rel}: references unknown skill id "${id}" — not in runtime/skills/index.js`);
				}
			}
		}
	}
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
