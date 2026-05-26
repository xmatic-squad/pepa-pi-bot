import { test } from "node:test";
import assert from "node:assert/strict";

import { isWatchableJs } from "./watch-filter.js";

test("isWatchableJs accepts top-level runtime js", () => {
	assert.equal(isWatchableJs("bot.js"), true);
	assert.equal(isWatchableJs("reflex.js"), true);
});

test("isWatchableJs accepts nested skills/social js (recursive watch)", () => {
	assert.equal(isWatchableJs("skills/index.js"), true);
	assert.equal(isWatchableJs("skills/chop-logs.js"), true);
	assert.equal(isWatchableJs("social/intent.js"), true);
});

test("isWatchableJs rejects *.test.js everywhere (root of restart storm)", () => {
	assert.equal(isWatchableJs("reflex.test.js"), false);
	assert.equal(isWatchableJs("base-site.test.js"), false);
	assert.equal(isWatchableJs("skills/contract.test.js"), false);
	assert.equal(isWatchableJs("skills/compat.test.js"), false);
});

test("isWatchableJs rejects supervisor.js itself", () => {
	assert.equal(isWatchableJs("supervisor.js"), false);
});

test("isWatchableJs rejects non-js / empty input", () => {
	assert.equal(isWatchableJs(""), false);
	assert.equal(isWatchableJs(null), false);
	assert.equal(isWatchableJs("notes.md"), false);
	assert.equal(isWatchableJs("config.json"), false);
});
