import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSkillCalls } from "./lint-patch.js";

test("extractSkillCalls: runSkill double-quoted", () => {
	const code = `await runSkill("gather.logs", ctx, args);`;
	assert.deepEqual(extractSkillCalls(code), ["gather.logs"]);
});

test("extractSkillCalls: getSkill backtick", () => {
	const code = "const s = getSkill(`village.deposit-surplus`);";
	assert.deepEqual(extractSkillCalls(code), ["village.deposit-surplus"]);
});

test("extractSkillCalls: multiple unique ids dedupe", () => {
	const code = `
		await runSkill("gather.logs", ctx);
		const s = getSkill('gather.stone');
		await runSkill("gather.logs", ctx); // duplicate
	`;
	assert.deepEqual(extractSkillCalls(code).sort(), ["gather.logs", "gather.stone"]);
});

test("extractSkillCalls: ignores template literals it can't verify", () => {
	const code = "await runSkill(`${dynamicId}`, ctx);";
	// Pattern requires literal — dynamic ids are not extracted (and not lint-checked).
	const out = extractSkillCalls(code);
	assert.equal(out.length, 0);
});

test("extractSkillCalls: tolerates whitespace + newlines", () => {
	const code = `await runSkill(
		"explore.far",
		ctx,
		args,
	);`;
	assert.deepEqual(extractSkillCalls(code), ["explore.far"]);
});
