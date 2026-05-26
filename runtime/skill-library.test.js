import { test } from "node:test";
import assert from "node:assert/strict";
import { wordOverlapScore, relevantSkillDocs, renderRelevantDocs, _resetCache } from "./skill-library.js";

test("wordOverlapScore: identical strings → ~1", () => {
	const s = wordOverlapScore("chop nearest tree", "chop nearest tree");
	assert.ok(s > 0.9);
});

test("wordOverlapScore: disjoint strings → 0", () => {
	const s = wordOverlapScore("alpha beta gamma", "zeta eta theta");
	assert.equal(s, 0);
});

test("wordOverlapScore: stopwords don't dominate", () => {
	const s = wordOverlapScore("the and of for in", "the and of for in");
	assert.equal(s, 0);
});

test("wordOverlapScore: tokens shorter than 3 chars ignored", () => {
	const s = wordOverlapScore("a b c", "a b c");
	assert.equal(s, 0);
});

test("relevantSkillDocs: ranks logs-related query toward gather.logs", () => {
	_resetCache();
	const picked = relevantSkillDocs("bot cannot chop a tree, gather.logs returns no_target");
	const ids = picked.map((e) => e.id);
	assert.ok(ids.includes("gather.logs"), `expected gather.logs in top-k, got ${ids.join(",")}`);
});

test("relevantSkillDocs: alwaysShow guarantees inclusion", () => {
	_resetCache();
	const picked = relevantSkillDocs("totally unrelated string", { k: 1, alwaysShow: ["explore.far"] });
	const ids = picked.map((e) => e.id);
	assert.ok(ids.includes("explore.far"));
});

test("renderRelevantDocs: produces non-empty markdown for known query", () => {
	_resetCache();
	const md = renderRelevantDocs("gather logs from nearby tree", { k: 2 });
	assert.ok(md.includes("###"));
	assert.ok(md.includes("gather.logs") || md.includes("chop"));
});
