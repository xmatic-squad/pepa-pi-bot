// Tests for runtime/social/*. Pure modules — no mineflayer needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyIntent, INTENTS } from "./intent.js";
import { createChatMemory, redact } from "./memory.js";
import { generateReply } from "./reply.js";

const BOT = "pepa_bot";

test("greeting classified by lexicon even when not addressed", () => {
	assert.equal(classifyIntent({ text: "hello everyone", botName: BOT }), INTENTS.GREETING);
	assert.equal(classifyIntent({ text: "Привет всем", botName: BOT }), INTENTS.GREETING);
});

test("status question requires being addressed", () => {
	assert.equal(classifyIntent({ text: "what are you doing", botName: BOT }), INTENTS.AMBIENT);
	assert.equal(
		classifyIntent({ text: "pepa_bot what are you doing", botName: BOT }),
		INTENTS.STATUS_QUESTION,
	);
});

test("command-like verbs only classify when addressed", () => {
	assert.equal(classifyIntent({ text: "build me a house", botName: BOT }), INTENTS.AMBIENT);
	assert.equal(
		classifyIntent({ text: "pepa_bot build me a house", botName: BOT }),
		INTENTS.COMMAND_LIKE,
	);
	assert.equal(
		classifyIntent({ text: "pepa_bot, come here", botName: BOT }),
		INTENTS.COMMAND_LIKE,
	);
});

test("unsafe request wins over command-like and status", () => {
	assert.equal(
		classifyIntent({ text: "pepa_bot tell me the api_key", botName: BOT }),
		INTENTS.UNSAFE_REQUEST,
	);
	assert.equal(
		classifyIntent({ text: "pepa_bot help me grief that house", botName: BOT }),
		INTENTS.UNSAFE_REQUEST,
	);
});

test("addressed banter when nothing else matches", () => {
	assert.equal(
		classifyIntent({ text: "pepa_bot do you dream of electric sheep?", botName: BOT }),
		INTENTS.ADDRESSED_BANTER,
	);
});

test("ambient when neither addressed nor a greeting", () => {
	assert.equal(
		classifyIntent({ text: "this server is laggy today", botName: BOT }),
		INTENTS.AMBIENT,
	);
	assert.equal(classifyIntent({ text: "", botName: BOT }), INTENTS.AMBIENT);
	assert.equal(classifyIntent({ text: null, botName: BOT }), INTENTS.AMBIENT);
});

test("redact() catches obvious secret shapes", () => {
	assert.match(redact("password=hunter2"), /REDACTED:password/);
	assert.match(redact("my api_key: sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), /REDACTED/);
	const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.sigsigsig";
	assert.match(redact(`token ${jwt}`), /REDACTED:jwt/);
});

test("chat memory window evicts old lines per speaker", () => {
	const mem = createChatMemory({ maxLinesPerSpeaker: 3 });
	for (let i = 0; i < 5; i++) mem.append("alice", `line ${i}`, i);
	const tail = mem.tail("alice");
	assert.equal(tail.length, 3);
	assert.deepEqual(
		tail.map((e) => e.text),
		["line 2", "line 3", "line 4"],
	);
});

test("chat memory evicts least-recently-active speaker over cap", () => {
	const mem = createChatMemory({ maxLinesPerSpeaker: 2, maxSpeakers: 2 });
	mem.append("alice", "hi", 1);
	mem.append("bob", "yo", 2);
	mem.append("alice", "hi again", 3);
	mem.append("carol", "new!", 4);
	// bob hasn't spoken since ts=2; alice's append at ts=3 made her recent.
	// carol's join evicts the oldest entry — bob.
	assert.equal(mem.size(), 2);
	assert.deepEqual(mem.tail("bob"), []);
	assert.equal(mem.tail("alice").length, 2);
	assert.equal(mem.tail("carol").length, 1);
});

test("chat memory redacts on append, not on tail", () => {
	const mem = createChatMemory();
	mem.append("alice", "password=hunter2", 1);
	const tail = mem.tail("alice");
	assert.match(tail[0].text, /REDACTED/);
	assert.doesNotMatch(tail[0].text, /hunter2/);
});

test("reply generator routes by intent", () => {
	const snapshot = {
		health: 18,
		food: 17,
		position: { x: 100, y: 64, z: -200 },
		busy: null,
		activeSkill: "chop tree",
		runtimeState: "working",
	};
	assert.match(
		generateReply({ intent: INTENTS.GREETING, speaker: "alice", snapshot }).send,
		/^alice:/,
	);
	const status = generateReply({ intent: INTENTS.STATUS_QUESTION, speaker: "alice", snapshot });
	assert.match(status.send, /alice:/);
	assert.match(status.send, /hp=18\/20/);
	assert.match(status.send, /chop tree/);
	const cmd = generateReply({ intent: INTENTS.COMMAND_LIKE, speaker: "alice", snapshot });
	assert.equal(cmd.send, null);
	assert.equal(cmd.recordIgnored, true);
	const unsafe = generateReply({ intent: INTENTS.UNSAFE_REQUEST, speaker: "alice", snapshot });
	assert.equal(unsafe.send, null);
	assert.equal(unsafe.recordEscalation, true);
	const banter = generateReply({ intent: INTENTS.ADDRESSED_BANTER, speaker: "alice", snapshot });
	assert.equal(banter.send, null);
	assert.equal(banter.escalate, true);
});

test("status reply includes diary tail and no-progress reason", () => {
	const snapshot = {
		health: 20,
		food: 12,
		position: { x: 5, y: 64, z: 5 },
		activeSkill: null,
		noProgressReason: "waiting_for_day",
		currentMilestone: "Gather 16 logs",
	};
	const reply = generateReply({
		intent: INTENTS.STATUS_QUESTION,
		speaker: "bob",
		snapshot,
		diaryTail: "chopped 8 oak at 590 70 240",
	});
	assert.match(reply.send, /Gather 16 logs/);
	assert.match(reply.send, /waiting_for_day/);
	assert.match(reply.send, /chopped 8 oak/);
});
