import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "./reply-pi.js";

test("sanitiseReply: strip 'pepa:' prefix", () => {
	assert.equal(_internal.sanitiseReply("pepa: здаров"), "здаров");
	assert.equal(_internal.sanitiseReply("pepa_bot: дерево рублю"), "дерево рублю");
});

test("sanitiseReply: strip code fences", () => {
	assert.equal(_internal.sanitiseReply("```\nхай\n```"), "хай");
	assert.equal(_internal.sanitiseReply("```ru\nага\n```"), "ага");
});

test("sanitiseReply: strip surrounding quotes", () => {
	assert.equal(_internal.sanitiseReply('"здаров"'), "здаров");
	assert.equal(_internal.sanitiseReply("'занят'"), "занят");
});

test("sanitiseReply: only first non-empty line", () => {
	assert.equal(_internal.sanitiseReply("здаров\n\nкак сам?"), "здаров");
});

test("sanitiseReply: caps at 200 chars", () => {
	const long = "д".repeat(500);
	const s = _internal.sanitiseReply(long);
	assert.equal(s.length, 200);
});

test("sanitiseReply: empty / nullish → null", () => {
	assert.equal(_internal.sanitiseReply(""), null);
	assert.equal(_internal.sanitiseReply(null), null);
	assert.equal(_internal.sanitiseReply("   \n  \n  "), null);
});

test("buildPrompt: contains the player name and the incoming text", () => {
	const p = _internal.buildPrompt({
		player: "halofourteen",
		text: "что делаешь?",
		snapshot: { position: { x: 100, y: 64, z: -10 }, health: 20, food: 18, isDay: true, activeSkill: "gather.logs", currentMilestone: "Gather 16 logs" },
		diaryTail: "вчера спал на дереве",
	});
	assert.ok(p.includes("halofourteen"));
	assert.ok(p.includes("что делаешь?"));
	assert.ok(p.includes("gather.logs"));
	assert.ok(p.includes("вчера спал на дереве"));
	assert.ok(p.includes("Ты — pepa_bot"));
});
