// Contract tests for runtime/skills/index.js. Run with: node --test runtime/skills
//
// We avoid spinning up a real mineflayer bot — synthetic skills are
// registered via _registerForTest and exercise every branch of runSkill:
// preconditions, timeout, exception, validate, recover.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runSkill, RUNNER_CODES, _registerForTest } from "./index.js";
import { __testing as scoutFoodTesting } from "./scout-food.js";

const ctx = {}; // skills under test ignore ctx fully

test("unknown skill returns unknown_skill code", async () => {
	const res = await runSkill("does.not.exist", ctx);
	assert.equal(res.ok, false);
	assert.equal(res.code, RUNNER_CODES.UNKNOWN_SKILL);
});

test("preconditions gate execution", async () => {
	const teardown = _registerForTest({
		id: "test.precondition-block",
		title: "blocked",
		timeoutMs: 1000,
		preconditions: () => ({ ok: false, code: "missing_x", detail: "no x" }),
		execute: async () => {
			throw new Error("should not run");
		},
	});
	try {
		const res = await runSkill("test.precondition-block", ctx);
		assert.equal(res.ok, false);
		assert.equal(res.code, "missing_x");
		assert.equal(res.detail, "no x");
	} finally {
		teardown();
	}
});

test("precondition failures can return recovery hints", async () => {
	const teardown = _registerForTest({
		id: "test.precondition-recover",
		title: "blocked with recovery",
		timeoutMs: 1000,
		preconditions: () => ({ ok: false, code: "no_target", detail: "none nearby" }),
		execute: async () => {
			throw new Error("should not run");
		},
		recover: (_ctx, result) => ({ hint: "scout-food", saw: result.code }),
	});
	try {
		const res = await runSkill("test.precondition-recover", ctx);
		assert.equal(res.ok, false);
		assert.equal(res.code, "no_target");
		assert.deepEqual(res.recovery, { hint: "scout-food", saw: "no_target" });
	} finally {
		teardown();
	}
});

test("gather.logs precondition refuses nearby hostiles", async () => {
	const bot = { registry: { blocksByName: { oak_log: { id: 1 } } } };
	const res = await runSkill("gather.logs", {
		bot,
		snapshot: { closestHostile: { name: "drowned", distance: 6.1 } },
	});
	assert.equal(res.ok, false);
	assert.equal(res.code, "no_target");
	assert.match(res.detail, /unsafe to gather logs: drowned 6\.1 blocks away/);
});

test("scout-food progress counts intended cardinal, not sideways tunnel drift", () => {
	const north = scoutFoodTesting.CARDINALS.find((c) => c.name === "N");
	assert.deepEqual(
		scoutFoodTesting.cardinalProgress({ x: 0, z: 0 }, { x: 0, z: -9 }, north),
		{ along: 9, total: 9, driftName: "N" },
	);
	assert.deepEqual(
		scoutFoodTesting.cardinalProgress({ x: 0, z: 0 }, { x: 9, z: 0 }, north),
		{ along: 0, total: 9, driftName: "E" },
	);
});

test("preconditions that throw produce precondition_failed", async () => {
	const teardown = _registerForTest({
		id: "test.precondition-throw",
		preconditions: () => {
			throw new Error("kaboom");
		},
		execute: async () => ({ ok: true }),
	});
	try {
		const res = await runSkill("test.precondition-throw", ctx);
		assert.equal(res.ok, false);
		assert.equal(res.code, RUNNER_CODES.PRECONDITION_FAILED);
		assert.match(res.detail, /kaboom/);
	} finally {
		teardown();
	}
});

test("timeout fires and recover is called", async () => {
	let recovered = false;
	const teardown = _registerForTest({
		id: "test.timeout",
		timeoutMs: 50,
		preconditions: () => ({ ok: true }),
		execute: () =>
			new Promise((resolve) => {
				// never resolves within the timeout
				setTimeout(() => resolve({ ok: true }), 500);
			}),
		recover: () => {
			recovered = true;
			return { hint: "retry-later" };
		},
	});
	try {
		const res = await runSkill("test.timeout", ctx);
		assert.equal(res.ok, false);
		assert.equal(res.code, RUNNER_CODES.TIMEOUT);
		assert.equal(recovered, true);
		assert.deepEqual(res.recovery, { hint: "retry-later" });
	} finally {
		teardown();
	}
});

test("execute throw -> threw code with recovery hint", async () => {
	const teardown = _registerForTest({
		id: "test.throws",
		preconditions: () => ({ ok: true }),
		execute: async () => {
			throw new Error("oops");
		},
		recover: (ctx, result) => ({ saw: result.code }),
	});
	try {
		const res = await runSkill("test.throws", ctx);
		assert.equal(res.ok, false);
		assert.equal(res.code, RUNNER_CODES.THREW);
		assert.match(res.detail, /oops/);
		assert.deepEqual(res.recovery, { saw: RUNNER_CODES.THREW });
	} finally {
		teardown();
	}
});

test("happy path returns done with worldDelta", async () => {
	const teardown = _registerForTest({
		id: "test.happy",
		preconditions: () => ({ ok: true }),
		execute: async () => ({ ok: true, code: "done", detail: { count: 4 }, worldDelta: { gathered: 4 } }),
	});
	try {
		const res = await runSkill("test.happy", ctx);
		assert.equal(res.ok, true);
		assert.equal(res.code, "done");
		assert.deepEqual(res.worldDelta, { gathered: 4 });
	} finally {
		teardown();
	}
});

test("validate failure flips ok to false with validation_failed", async () => {
	let recoverArgs = null;
	const teardown = _registerForTest({
		id: "test.validate-fail",
		preconditions: () => ({ ok: true }),
		execute: async () => ({ ok: true, code: "done", worldDelta: { x: 1 } }),
		validate: () => false,
		recover: (ctx, result) => {
			recoverArgs = result;
			return null;
		},
	});
	try {
		const res = await runSkill("test.validate-fail", ctx);
		assert.equal(res.ok, false);
		assert.equal(res.code, RUNNER_CODES.VALIDATION_FAILED);
		assert.ok(recoverArgs);
		assert.equal(recoverArgs.code, RUNNER_CODES.VALIDATION_FAILED);
	} finally {
		teardown();
	}
});

test("result missing code defaults to runner DONE on success", async () => {
	const teardown = _registerForTest({
		id: "test.no-code",
		preconditions: () => ({ ok: true }),
		execute: async () => ({ ok: true }),
	});
	try {
		const res = await runSkill("test.no-code", ctx);
		assert.equal(res.ok, true);
		assert.equal(res.code, RUNNER_CODES.DONE);
	} finally {
		teardown();
	}
});

test("abortSignal: mid-execute abort surfaces code: preempted", async () => {
	const teardown = _registerForTest({
		id: "test.preempt-midflight",
		timeoutMs: 5000,
		preconditions: () => ({ ok: true }),
		execute: async () => {
			await new Promise((r) => setTimeout(r, 1500));
			return { ok: true };
		},
	});
	const controller = new AbortController();
	const runP = runSkill("test.preempt-midflight", { abortSignal: controller.signal });
	setTimeout(() => controller.abort(), 30);
	try {
		const res = await runP;
		assert.equal(res.ok, false);
		assert.equal(res.code, RUNNER_CODES.PREEMPTED);
	} finally {
		teardown();
	}
});

test("abortSignal: pre-aborted signal short-circuits to preempted", async () => {
	const teardown = _registerForTest({
		id: "test.preempt-prearm",
		timeoutMs: 5000,
		preconditions: () => ({ ok: true }),
		execute: async () => {
			await new Promise((r) => setTimeout(r, 200));
			return { ok: true };
		},
	});
	const controller = new AbortController();
	controller.abort();
	try {
		const res = await runSkill("test.preempt-prearm", { abortSignal: controller.signal });
		assert.equal(res.ok, false);
		assert.equal(res.code, RUNNER_CODES.PREEMPTED);
	} finally {
		teardown();
	}
});

test("abortSignal: not aborted → skill completes normally", async () => {
	const teardown = _registerForTest({
		id: "test.preempt-clear",
		timeoutMs: 5000,
		preconditions: () => ({ ok: true }),
		execute: async () => ({ ok: true, code: "done" }),
	});
	const controller = new AbortController();
	try {
		const res = await runSkill("test.preempt-clear", { abortSignal: controller.signal });
		assert.equal(res.ok, true);
		assert.equal(res.code, "done");
	} finally {
		teardown();
	}
});
