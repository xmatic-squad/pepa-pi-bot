import { test } from "node:test";
import assert from "node:assert/strict";
import { registerMode, tickModes, listModes, setModeEnabled, _resetModes } from "./modes.js";

test("tickModes: first mode that fires wins", async () => {
	_resetModes();
	registerMode({
		name: "high",
		interrupts: ["all"],
		update: () => ({ action: { skillId: "from-high" } }),
	});
	registerMode({
		name: "low",
		update: () => ({ action: { skillId: "from-low" } }),
	});
	const out = tickModes({});
	assert.equal(out.mode, "high");
	assert.equal(out.action.skillId, "from-high");
});

test("tickModes: disabled mode is skipped", async () => {
	_resetModes();
	registerMode({ name: "skipme", update: () => ({ action: { skillId: "x" } }) });
	registerMode({ name: "use", update: () => ({ action: { skillId: "y" } }) });
	setModeEnabled("skipme", false);
	const out = tickModes({});
	assert.equal(out.mode, "use");
});

test("tickModes: returns null when no mode fires", async () => {
	_resetModes();
	registerMode({ name: "silent", update: () => null });
	const out = tickModes({});
	assert.equal(out, null);
});

test("tickModes: thrown update doesn't break the chain", async () => {
	_resetModes();
	registerMode({
		name: "throws",
		update: () => { throw new Error("boom"); },
	});
	registerMode({
		name: "next",
		update: () => ({ action: { skillId: "rescued" } }),
	});
	const out = tickModes({});
	assert.equal(out.mode, "next");
});

test("registerMode: same name replaces, doesn't duplicate", async () => {
	_resetModes();
	registerMode({ name: "x", update: () => ({ action: { skillId: "v1" } }) });
	registerMode({ name: "x", update: () => ({ action: { skillId: "v2" } }) });
	const out = tickModes({});
	assert.equal(out.action.skillId, "v2");
	assert.equal(listModes().length, 1);
});

test("standard modes load on import", async () => {
	const mod = await import(`./modes.js?cb=${Date.now()}`);
	const names = mod.listModes().map((m) => m.name);
	assert.ok(names.includes("self_preservation"));
	assert.ok(names.includes("hunger"));
	assert.ok(names.includes("night_shelter"));
});

test("self_preservation: low-HP + food + hasFood → eat", async () => {
	_resetModes();
	const mod = await import(`./modes.js?cb=${Date.now() + 1}`);
	const out = mod.tickModes({ snapshot: { health: 4, food: 10, hasFood: true } });
	assert.equal(out.mode, "self_preservation");
	assert.equal(out.action.skillId, "survive.eat");
});

test("hunger: food below 14 with food → eat", async () => {
	_resetModes();
	const mod = await import(`./modes.js?cb=${Date.now() + 2}`);
	const out = mod.tickModes({ snapshot: { health: 20, food: 12, hasFood: true } });
	assert.equal(out.action.skillId, "survive.eat");
});

test("night_shelter: day → null (skip)", async () => {
	_resetModes();
	const mod = await import(`./modes.js?cb=${Date.now() + 3}`);
	const out = mod.tickModes({ snapshot: { isDay: true, food: 20, hasFood: false, inventory: { red_bed: 1 } } });
	assert.equal(out, null);
});

test("night_shelter: night + bed in hand → sleep", async () => {
	_resetModes();
	const mod = await import(`./modes.js?cb=${Date.now() + 4}`);
	const out = mod.tickModes({ snapshot: { isDay: false, food: 20, hasFood: false, inventory: { red_bed: 1 } } });
	assert.equal(out.action.skillId, "survive.sleep");
});
