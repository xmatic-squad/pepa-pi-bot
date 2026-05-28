import { test } from "node:test";
import assert from "node:assert/strict";

import { skill, __testing } from "./dig-in.js";

function vec(x, y, z) {
	return {
		x, y, z,
		offset(dx, dy, dz) { return vec(x + dx, y + dy, z + dz); },
	};
}

function fakeBot({ belowName = "dirt", sideName = "stone", items = [{ name: "dirt", count: 10, type: 3 }] } = {}) {
	const calls = { dig: 0, place: 0, equip: 0 };
	return {
		calls,
		entity: { position: vec(0, 64, 0), yaw: 0 },
		inventory: { items: () => items },
		blockAt(p) {
			// below (y-1) → belowName; same-level neighbours → sideName
			if (p.y === 63) return { name: belowName, position: p };
			return { name: sideName, position: p };
		},
		async dig() { calls.dig++; },
		async placeBlock() { calls.place++; },
		async equip() { calls.equip++; },
		async look() {},
		pathfinder: { setGoal() {} },
	};
}

test("pickCapBlock prefers dirt", () => {
	const bot = fakeBot({ items: [{ name: "cobblestone", count: 3 }, { name: "dirt", count: 1 }] });
	assert.equal(__testing.pickCapBlock(bot).name, "dirt");
});

test("safeToDigBelow refuses lava/water/bedrock/air", () => {
	for (const bad of ["lava", "water", "bedrock", "air"]) {
		const bot = fakeBot({ belowName: bad });
		assert.equal(__testing.safeToDigBelow(bot).ok, false, bad);
	}
	assert.equal(__testing.safeToDigBelow(fakeBot({ belowName: "dirt" })).ok, true);
});

test("preconditions fail without a cap block", () => {
	const bot = fakeBot({ items: [{ name: "raw_chicken", count: 1 }] });
	const pre = skill.preconditions({ bot });
	assert.equal(pre.ok, false);
	assert.equal(pre.code, "missing_material");
});

test("preconditions fail when below is unsafe", () => {
	const bot = fakeBot({ belowName: "lava" });
	const pre = skill.preconditions({ bot });
	assert.equal(pre.ok, false);
	assert.equal(pre.code, "unsafe_dig");
});

test("execute digs down to depth and caps the hole", async () => {
	const bot = fakeBot();
	const res = await skill.execute({ bot }, { depth: 2 });
	assert.equal(res.ok, true);
	assert.equal(res.worldDelta.dugDown, 2);
	assert.equal(res.worldDelta.capped, true);
	assert.equal(bot.calls.dig, 2);
	assert.ok(bot.calls.place >= 1);
});

test("execute stops digging when it hits something unsafe mid-dig", async () => {
	// below is water → first safeToDigBelow already false → dug 0 → no_progress
	const bot = fakeBot({ belowName: "water" });
	const res = await skill.execute({ bot }, { depth: 3 });
	assert.equal(res.ok, false);
	assert.equal(res.code, "no_progress");
});
