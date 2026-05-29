// Pure formatting helpers for the monitor header. These assemble the per-tick
// "what / why / blocked / stalled" line from snapshot fields the bot already
// broadcasts, so the operator can see why the bot is (not) acting. Tested off
// ink — no React/render involved.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatStatusSegments, statusText, formatBlockedBy, stateColor } from "./format.js";

test("statusText surfaces state, firing rail, active skill and stall reason", () => {
	const txt = statusText({
		runtimeState: "idle",
		lastReflex: { name: "curriculum" },
		activeSkill: "gather.logs",
		noProgressReason: "waiting_for_day",
	});
	assert.match(txt, /idle/);
	assert.match(txt, /curriculum/);
	assert.match(txt, /gather\.logs/);
	assert.match(txt, /waiting_for_day/);
});

test("reflexPaused renders a PAUSED marker", () => {
	assert.match(statusText({ runtimeState: "working", reflexPaused: true }), /PAUSED/);
	assert.doesNotMatch(statusText({ runtimeState: "working", reflexPaused: false }), /PAUSED/);
});

test("blocked prerequisite is shown by name, never as [object Object]", () => {
	const snap = {
		runtimeState: "working",
		contract: { suggestedSkill: { skillId: "craft.torch", blockedBy: [{ item: "coal", min: 1, have: 0 }] } },
	};
	const txt = statusText(snap);
	assert.match(txt, /craft\.torch/);
	assert.match(txt, /coal/);
	assert.doesNotMatch(txt, /\[object Object\]/);
});

test("urgent contract reason (food preemption) is surfaced", () => {
	const txt = statusText({
		runtimeState: "working",
		contract: { reason: "urgent:M4_food_security(100) preempts M1_wood_tools" },
	});
	assert.match(txt, /urgent/);
});

test("formatBlockedBy maps {item,min} and {tool} objects, null when empty", () => {
	assert.equal(formatBlockedBy([]), null);
	assert.equal(formatBlockedBy(undefined), null);
	assert.equal(formatBlockedBy([{ item: "planks", min: 8, have: 0 }]), "planks×8");
	assert.equal(formatBlockedBy([{ tool: "pickaxe" }]), "pickaxe");
	assert.equal(formatBlockedBy([{ item: "coal", min: 1 }, { item: "stick", min: 1 }]), "coal+stick");
});

test("stateColor maps known states and defaults unknown ones to a visible colour", () => {
	assert.equal(stateColor("emergency"), "red");
	assert.equal(stateColor("idle"), "gray");
	assert.equal(stateColor("planning"), "magenta");
	// unknown / future states render in white rather than being blanked out
	assert.equal(stateColor("teleporting"), "white");
	assert.equal(stateColor(undefined), "gray");
});

test("empty snapshot yields no segments (header row collapses)", () => {
	assert.equal(formatStatusSegments({}).length, 0);
});
