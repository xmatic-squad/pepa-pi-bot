import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "./critic.js";

test("extractJsonObject: bare object", () => {
	const got = _internal.extractJsonObject('{"reasoning":"x","success":true,"critique":""}');
	assert.equal(got.success, true);
	assert.equal(got.reasoning, "x");
});

test("extractJsonObject: fenced markdown", () => {
	const got = _internal.extractJsonObject('```json\n{"reasoning":"a","success":false,"critique":"b"}\n```');
	assert.equal(got.success, false);
	assert.equal(got.critique, "b");
});

test("extractJsonObject: leading OUTPUT: prefix", () => {
	const got = _internal.extractJsonObject('OUTPUT:\n{"reasoning":"r","success":true,"critique":""}');
	assert.equal(got.reasoning, "r");
});

test("extractJsonObject: junk before object is tolerated", () => {
	const got = _internal.extractJsonObject('Some chatter from Pi.\n{"reasoning":"a","success":true,"critique":""}\nMore chatter.');
	assert.equal(got.success, true);
});

test("extractJsonObject: nested braces parse correctly", () => {
	const got = _internal.extractJsonObject('{"reasoning":"nest {a:1}","success":true,"critique":""}');
	assert.equal(got.success, true);
});

test("extractJsonObject: garbage returns null, not throw", () => {
	assert.equal(_internal.extractJsonObject("not json at all"), null);
	assert.equal(_internal.extractJsonObject(""), null);
	assert.equal(_internal.extractJsonObject(null), null);
});

test("buildUserBlock includes milestone + slim snapshot", () => {
	const s = _internal.buildUserBlock({
		snapshot: { position: { x: 1, y: 2, z: 3 }, health: 10, food: 17, inventory: { dirt: 1 } },
		lastResult: { label: "gather.logs", ok: false, code: "no_target", detail: "no reachable log" },
		scenarioTail: [{ skillId: "gather.logs", ok: false, code: "no_target" }],
		milestone: "chop 1 log",
		kind: "stuck-no_food_source",
	});
	assert.ok(s.includes("chop 1 log"));
	assert.ok(s.includes("no_target"));
	assert.ok(s.startsWith("INPUT:"));
	assert.ok(s.endsWith("OUTPUT:"));
});
