import { test } from "node:test";
import assert from "node:assert/strict";
import {
	openConversation,
	listConversations,
	peekConversation,
	_resetConversations,
} from "./conversation.js";

function topic() { return `_t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`; }

test("two bots in the same topic see each other's turns", () => {
	_resetConversations();
	const t = topic();
	const alice = openConversation(t, { speaker: "alice" });
	const bob = openConversation(t, { speaker: "bob" });
	alice.append({ position: { x: 1, y: 2, z: 3 }, intent: "chop", text: "I'm chopping oak" });
	bob.append({ position: { x: 10, y: 2, z: 3 }, intent: "mine", text: "I'm at the stone wall" });
	const seenByAlice = alice.recent({ n: 10 });
	assert.equal(seenByAlice.filter((t) => t.kind === "turn").length, 2);
	const fromsByBob = bob.recent({ excludeSelf: true })
		.filter((t) => t.kind === "turn")
		.map((t) => t.from);
	assert.deepEqual(fromsByBob, ["alice"]);
});

test("peers() returns every speaker seen in the topic", () => {
	_resetConversations();
	const t = topic();
	openConversation(t, { speaker: "x" }).append({ text: "hi" });
	openConversation(t, { speaker: "y" }).append({ text: "hello" });
	openConversation(t, { speaker: "z" }).append({ text: "yo" });
	const peers = openConversation(t, { speaker: "x" }).peers();
	assert.deepEqual(peers.sort(), ["x", "y", "z"]);
});

test("listConversations enumerates active topics", () => {
	_resetConversations();
	openConversation(topic(), { speaker: "a" });
	openConversation(topic(), { speaker: "b" });
	const all = listConversations();
	assert.ok(all.length >= 2);
});

test("recent() respects n", () => {
	_resetConversations();
	const t = topic();
	const h = openConversation(t, { speaker: "a" });
	for (let i = 0; i < 15; i++) h.append({ text: `msg${i}` });
	const last5 = h.recent({ n: 5 }).filter((x) => x.kind === "turn");
	assert.equal(last5.length, 5);
	assert.equal(last5[last5.length - 1].text, "msg14");
});

test("peekConversation works without an open handle", () => {
	_resetConversations();
	const t = topic();
	openConversation(t, { speaker: "lurker" }).append({ text: "hi" });
	const peeked = peekConversation(t, 5);
	assert.ok(peeked.find((p) => p.text === "hi"));
});

test("openConversation throws without topic or speaker", () => {
	assert.throws(() => openConversation(null, { speaker: "x" }));
	assert.throws(() => openConversation("t", {}));
});
