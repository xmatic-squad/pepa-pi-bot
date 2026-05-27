import { test } from "node:test";
import assert from "node:assert/strict";
import { skill, __testing } from "./pillar-up.js";

const { pickPillarBlock, inPit, PILLAR_PREFERENCE } = __testing;

function makePos(x, y, z) {
	return {
		x, y, z,
		offset(dx, dy, dz) { return makePos(x + dx, y + dy, z + dz); },
	};
}
function mockBot({ items = [], blocks = {}, pos = makePos(0, 64, 0) } = {}) {
	const handlers = {};
	return {
		entity: { position: pos, yaw: 0, pitch: 0 },
		inventory: { items: () => items },
		blockAt(p) { return blocks[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] ?? { name: "air" }; },
		on(ev, fn) { handlers[ev] = fn; },
		setControlState() {},
		async equip() { return true; },
		async look() { return true; },
		async placeBlock() { return true; },
	};
}

test("pickPillarBlock: chooses preferred block from inventory", () => {
	const items = [
		{ name: "stone", count: 4, type: 1 },
		{ name: "dirt", count: 12, type: 2 },
	];
	const chosen = pickPillarBlock(mockBot({ items }));
	assert.equal(chosen.name, "dirt", "prefers dirt over stone");
});

test("pickPillarBlock: returns null when nothing placeable", () => {
	const chosen = pickPillarBlock(mockBot({ items: [{ name: "carrot", count: 3 }] }));
	assert.equal(chosen, null);
});

test("pickPillarBlock: falls back to wood-like names", () => {
	const chosen = pickPillarBlock(mockBot({ items: [{ name: "oak_planks", count: 5 }] }));
	assert.equal(chosen.name, "oak_planks");
});

test("inPit: detects walls in cardinal directions", () => {
	const blocks = {
		"1,65,0": { name: "stone" },
		"-1,65,0": { name: "stone" },
	};
	const bot = mockBot({ blocks });
	assert.equal(inPit(bot), true, "two walls = pit");

	const open = mockBot({ blocks: {} });
	assert.equal(inPit(open), false);
});

test("inPit: detects walls 2 blocks away too", () => {
	const blocks = {
		"2,65,0": { name: "stone" },
		"0,65,-2": { name: "stone" },
	};
	const bot = mockBot({ blocks });
	assert.equal(inPit(bot), true);
});

test("PILLAR_PREFERENCE: dirt is highest priority", () => {
	assert.equal(PILLAR_PREFERENCE[0], "dirt");
	assert.ok(PILLAR_PREFERENCE.includes("cobblestone"));
});

test("skill: preconditions fail without placeable block", () => {
	const ctx = { bot: mockBot({ items: [{ name: "carrot", count: 1 }] }) };
	const pre = skill.preconditions(ctx);
	assert.equal(pre.ok, false);
	assert.equal(pre.code, "missing_material");
});

test("skill: preconditions pass with dirt", () => {
	const ctx = { bot: mockBot({ items: [{ name: "dirt", count: 8 }] }) };
	const pre = skill.preconditions(ctx);
	assert.equal(pre.ok, true);
});

test("skill: id and timeout are sensible", () => {
	assert.equal(skill.id, "survive.pillar-up");
	assert.ok(skill.timeoutMs >= 30_000 && skill.timeoutMs <= 90_000);
});
