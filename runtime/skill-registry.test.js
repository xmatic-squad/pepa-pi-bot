import { test } from "node:test";
import assert from "node:assert/strict";

import {
	listSkillIds,
	isRegistered,
	describeSkill,
	skillRegistryPrompt,
} from "./skill-registry.js";

test("registry: lists at least the known v0.2 skill set", () => {
	const ids = listSkillIds();
	assert.ok(ids.length >= 20, `expected 20+ skills, got ${ids.length}`);
	for (const must of [
		"gather.logs",
		"survive.eat",
		"survive.sleep",
		"survive.flee",
		"survive.pillar-up",
		"explore.far",
		"explore.wander",
		"recovery.tunnel-out",
		"village.choose-base",
		"village.build-shelter",
	]) {
		assert.ok(ids.includes(must), `registry missing ${must}`);
	}
});

test("isRegistered: true for real, false for hallucinated", () => {
	assert.equal(isRegistered("survive.flee"), true);
	assert.equal(isRegistered("relocate.surface"), false);
	assert.equal(isRegistered("choose.safe.surface"), false);
	assert.equal(isRegistered("gather.visible_log"), false);
	assert.equal(isRegistered("survive.shelter"), false);
	assert.equal(isRegistered("tunnel-out"), false, "missing recovery. prefix");
	assert.equal(isRegistered(null), false);
	assert.equal(isRegistered(""), false);
	assert.equal(isRegistered(42), false);
});

test("describeSkill: returns shape for known id", () => {
	const s = describeSkill("survive.pillar-up");
	assert.ok(s, "expected description");
	assert.equal(s.id, "survive.pillar-up");
	assert.ok(typeof s.timeoutMs === "number" && s.timeoutMs > 0);
});

test("registryPrompt: contains the real ids grouped by namespace", () => {
	const txt = skillRegistryPrompt();
	assert.match(txt, /Valid skill ids/);
	assert.match(txt, /survive:/);
	assert.match(txt, /- survive\.flee/);
	assert.match(txt, /- recovery\.tunnel-out/);
	assert.match(txt, /NEVER invent/);
	// must NOT contain hallucinated ids
	assert.doesNotMatch(txt, /relocate\.surface/);
	assert.doesNotMatch(txt, /survive\.shelter[^-]/);
});

test("registryPrompt: respects limit parameter", () => {
	const short = skillRegistryPrompt({ limit: 200 });
	assert.ok(short.length <= 200, `expected <=200, got ${short.length}`);
	assert.ok(short.endsWith("..."));
});
