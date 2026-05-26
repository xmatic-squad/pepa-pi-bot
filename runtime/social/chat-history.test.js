import { test } from "node:test";
import assert from "node:assert/strict";
import { appendChat, recentForPlayer, knownPlayers, renderHistory, _resetChatHistory } from "./chat-history.js";

function tag() { return `_p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`; }

test("append in + out, recentForPlayer returns chronological order", () => {
	_resetChatHistory();
	const p = tag();
	appendChat({ player: p, dir: "in", text: "Привет" });
	appendChat({ player: p, dir: "out", text: "yo" });
	appendChat({ player: p, dir: "in", text: "что делаешь?" });
	const last = recentForPlayer(p, 10);
	assert.equal(last.length, 3);
	assert.equal(last[0].dir, "in");
	assert.equal(last[1].dir, "out");
	assert.equal(last[2].text, "что делаешь?");
});

test("rejects malformed appends silently", () => {
	_resetChatHistory();
	const p = tag();
	appendChat({ player: p, dir: "in", text: "" }); // empty text
	appendChat({ player: p, dir: "bogus", text: "x" }); // bad dir
	appendChat({ player: null, dir: "in", text: "x" }); // no player
	assert.equal(recentForPlayer(p, 10).length, 0);
});

test("knownPlayers returns every player we wrote to", () => {
	_resetChatHistory();
	const a = tag(), b = tag();
	appendChat({ player: a, dir: "in", text: "hi" });
	appendChat({ player: b, dir: "in", text: "hello" });
	const known = knownPlayers();
	assert.ok(known.includes(a) && known.includes(b));
});

test("renderHistory produces 'player: text' lines", () => {
	_resetChatHistory();
	const p = tag();
	appendChat({ player: p, dir: "in", text: "Привет" });
	appendChat({ player: p, dir: "out", text: "yo" });
	const md = renderHistory(p, 10, "pepa_bot");
	assert.match(md, new RegExp(`${p}: Привет`));
	assert.match(md, /pepa_bot: yo/);
});

test("snapshot stores compact slim form", () => {
	_resetChatHistory();
	const p = tag();
	appendChat({
		player: p,
		dir: "out",
		text: "копаю",
		snapshot: { position: { x: 100.7, y: 64.1, z: -33.4 }, activeSkill: "gather.logs", currentMilestone: "Gather 16 logs", isDay: true },
	});
	const e = recentForPlayer(p, 1)[0];
	assert.deepEqual(e.snap.pos, { x: 101, y: 64, z: -33 });
	assert.equal(e.snap.activeSkill, "gather.logs");
});

test("text truncates at 500 chars", () => {
	_resetChatHistory();
	const p = tag();
	const long = "x".repeat(1000);
	appendChat({ player: p, dir: "in", text: long });
	const e = recentForPlayer(p, 1)[0];
	assert.equal(e.text.length, 500);
});
