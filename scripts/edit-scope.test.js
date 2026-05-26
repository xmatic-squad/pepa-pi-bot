import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEditScope, isFileInScope, validateChangedFiles, effectiveScope } from "./edit-scope.js";

test("parseEditScope returns null when no frontmatter present", () => {
	assert.equal(parseEditScope(""), null);
	assert.equal(parseEditScope("# no frontmatter\nbody"), null);
});

test("parseEditScope returns null when frontmatter has no editScope key", () => {
	const text = "---\nkind: test\napproved: false\n---\nbody";
	assert.equal(parseEditScope(text), null);
});

test("parseEditScope reads a JSON array", () => {
	const text = '---\nkind: test\neditScope: ["runtime/skills/eat.js","runtime/skills/"]\n---\nbody';
	assert.deepEqual(parseEditScope(text), ["runtime/skills/eat.js", "runtime/skills/"]);
});

test("parseEditScope strips leading ./ and / from entries", () => {
	const text = '---\neditScope: ["./runtime/", "/scripts/edit-scope.js"]\n---\n';
	assert.deepEqual(parseEditScope(text), ["runtime/", "scripts/edit-scope.js"]);
});

test("parseEditScope returns null for malformed JSON", () => {
	const text = "---\neditScope: not-json\n---\n";
	assert.equal(parseEditScope(text), null);
});

test("isFileInScope: directory prefix matches descendants", () => {
	assert.equal(isFileInScope("runtime/skills/eat.js", ["runtime/skills/"]), true);
	assert.equal(isFileInScope("runtime/bot.js", ["runtime/skills/"]), false);
});

test("isFileInScope: bare directory name matches as prefix", () => {
	// "runtime/skills" should still cover "runtime/skills/foo.js"
	assert.equal(isFileInScope("runtime/skills/foo.js", ["runtime/skills"]), true);
	// but not "runtime/skillsX/foo.js"
	assert.equal(isFileInScope("runtime/skillsX/foo.js", ["runtime/skills"]), false);
});

test("isFileInScope: exact file match", () => {
	assert.equal(isFileInScope("runtime/bot.js", ["runtime/bot.js"]), true);
	assert.equal(isFileInScope("runtime/bot.js.bak", ["runtime/bot.js"]), false);
});

test("validateChangedFiles: all in-scope → ok", () => {
	const out = validateChangedFiles(
		["runtime/skills/eat.js", "runtime/skills/groups.js"],
		["runtime/skills/"],
	);
	assert.equal(out.ok, true);
	assert.deepEqual(out.outsideFiles, []);
});

test("validateChangedFiles: any out-of-scope → not ok, list returned", () => {
	const out = validateChangedFiles(
		["runtime/skills/eat.js", "package.json", ".env"],
		["runtime/skills/"],
	);
	assert.equal(out.ok, false);
	assert.deepEqual(out.outsideFiles.sort(), [".env", "package.json"]);
});

test("validateChangedFiles: falls back to default scope when empty", () => {
	const out = validateChangedFiles(["runtime/bot.js"], null);
	assert.equal(out.ok, true);
	assert.deepEqual(out.effectiveScope, ["runtime/"]);
});

test("validateChangedFiles: default scope rejects scripts/", () => {
	const out = validateChangedFiles(["scripts/auto-patch.js"], []);
	assert.equal(out.ok, false);
	assert.deepEqual(out.outsideFiles, ["scripts/auto-patch.js"]);
});

test("effectiveScope mirrors fallback", () => {
	assert.deepEqual(effectiveScope(null), ["runtime/"]);
	assert.deepEqual(effectiveScope([]), ["runtime/"]);
	assert.deepEqual(effectiveScope(["x/"]), ["x/"]);
});
