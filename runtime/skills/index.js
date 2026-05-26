// Skill substrate. A skill is a small, self-contained, composable unit of
// survival behaviour that the scheduler (today: reflex.js) can call with a
// uniform contract. The contract — required by every skill in this folder:
//
//   {
//     id: "namespace.action",      // stable, machine-readable, e.g. "gather.logs"
//     title: "Human label",
//     timeoutMs: 45_000,           // hard ceiling on execute()
//     preconditions(ctx) -> { ok, code?, detail? }
//     async execute(ctx, args)    -> { ok, code, detail, worldDelta }
//     validate?(ctx, result)      -> boolean       // optional gate after execute
//     recover?(ctx, result)       -> any | null    // optional follow-up hint
//   }
//
// The runSkill() wrapper enforces the timeout, normalises the result shape
// (so any caller can rely on the five required fields), runs validate(), and
// calls recover() on failure for the scheduler to consume.
//
// Skills are pure with respect to the runtime — they never read or write
// state-store directly; their `worldDelta` is the only way they communicate
// observed changes back to the scheduler, which then decides what to log.

import { info, warn } from "../log.js";

import { skill as chopLogs } from "./chop-logs.js";
import { skill as eat } from "./eat.js";
import { skill as wander } from "./wander.js";
import { skill as gatherStone } from "./gather-stone.js";
import { skill as gatherWool } from "./gather-wool.js";
import { skill as chooseBase } from "./choose-base.js";
import { skill as buildShelter } from "./build-shelter.js";
import { skill as depositSurplus } from "./deposit-surplus.js";
import { skill as farmWheat } from "./farm-wheat.js";
import {
	craftPlanksSkill,
	craftSticksSkill,
	craftWoodenAxeSkill,
	craftWoodenPickaxeSkill,
	craftWoodenSwordSkill,
	craftStoneAxeSkill,
	craftStonePickaxeSkill,
	craftStoneSwordSkill,
	craftFurnaceSkill,
	craftChestSkill,
	craftTorchSkill,
	craftBedSkill,
} from "./craft.js";

const SKILLS = new Map();

function register(skill) {
	if (!skill || typeof skill !== "object") throw new Error("skill: not an object");
	if (!skill.id || typeof skill.id !== "string") throw new Error("skill: missing id");
	if (typeof skill.execute !== "function") throw new Error(`skill ${skill.id}: missing execute`);
	if (typeof skill.preconditions !== "function") throw new Error(`skill ${skill.id}: missing preconditions`);
	if (SKILLS.has(skill.id)) throw new Error(`skill ${skill.id}: already registered`);
	SKILLS.set(skill.id, skill);
}

register(chopLogs);
register(eat);
register(wander);
register(gatherStone);
register(gatherWool);
register(chooseBase);
register(buildShelter);
register(depositSurplus);
register(farmWheat);
register(craftPlanksSkill);
register(craftSticksSkill);
register(craftWoodenAxeSkill);
register(craftWoodenPickaxeSkill);
register(craftWoodenSwordSkill);
register(craftStoneAxeSkill);
register(craftStonePickaxeSkill);
register(craftStoneSwordSkill);
register(craftFurnaceSkill);
register(craftChestSkill);
register(craftTorchSkill);
register(craftBedSkill);

export function listSkills() {
	return Array.from(SKILLS.values()).map((s) => ({
		id: s.id,
		title: s.title ?? s.id,
		timeoutMs: s.timeoutMs ?? 30_000,
	}));
}

export function getSkill(id) {
	return SKILLS.get(id) ?? null;
}

// Stable failure codes the wrapper itself can emit. Skills may emit any
// additional codes — but these are the ones runSkill produces.
export const RUNNER_CODES = Object.freeze({
	UNKNOWN_SKILL: "unknown_skill",
	PRECONDITION_FAILED: "precondition_failed",
	TIMEOUT: "timeout",
	THREW: "threw",
	VALIDATION_FAILED: "validation_failed",
	DONE: "done",
});

function normaliseResult(res, fallbackCode) {
	const ok = !!res?.ok;
	return {
		ok,
		code: res?.code ?? (ok ? RUNNER_CODES.DONE : fallbackCode ?? "failed"),
		detail: res?.detail ?? null,
		worldDelta: res?.worldDelta ?? null,
	};
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Drive one skill through its full lifecycle. The caller (typically reflex.js
// or, eventually, a higher-level scheduler) decides when to invoke; runSkill
// only owns the contract enforcement.
export async function runSkill(id, ctx, args = {}) {
	const skill = SKILLS.get(id);
	if (!skill) {
		warn("skill", `unknown skill ${id}`);
		return { ok: false, code: RUNNER_CODES.UNKNOWN_SKILL, detail: id, worldDelta: null };
	}

	let pre;
	try {
		pre = skill.preconditions(ctx, args) ?? { ok: true };
	} catch (e) {
		return {
			ok: false,
			code: RUNNER_CODES.PRECONDITION_FAILED,
			detail: `preconditions threw: ${e.message}`,
			worldDelta: null,
		};
	}
	if (!pre.ok) {
		return {
			ok: false,
			code: pre.code ?? RUNNER_CODES.PRECONDITION_FAILED,
			detail: pre.detail ?? "preconditions failed",
			worldDelta: null,
		};
	}

	const timeoutMs = skill.timeoutMs ?? 30_000;
	let raw;
	try {
		raw = await withTimeout(skill.execute(ctx, args), timeoutMs, `skill(${id})`);
	} catch (e) {
		const isTimeout = /timed out after/.test(e.message);
		const result = {
			ok: false,
			code: isTimeout ? RUNNER_CODES.TIMEOUT : RUNNER_CODES.THREW,
			detail: e.message,
			worldDelta: null,
		};
		if (typeof skill.recover === "function") {
			try {
				result.recovery = skill.recover(ctx, result) ?? null;
			} catch (recoverErr) {
				warn("skill", `${id}.recover threw: ${recoverErr.message}`);
			}
		}
		return result;
	}

	const result = normaliseResult(raw);
	if (result.ok && typeof skill.validate === "function") {
		let valid;
		try {
			valid = skill.validate(ctx, result);
		} catch (e) {
			warn("skill", `${id}.validate threw: ${e.message}`);
			valid = false;
		}
		if (!valid) {
			const failed = {
				ok: false,
				code: RUNNER_CODES.VALIDATION_FAILED,
				detail: result.detail,
				worldDelta: result.worldDelta,
			};
			if (typeof skill.recover === "function") {
				try {
					failed.recovery = skill.recover(ctx, failed) ?? null;
				} catch (e) {
					warn("skill", `${id}.recover threw: ${e.message}`);
				}
			}
			return failed;
		}
	}
	if (!result.ok && typeof skill.recover === "function") {
		try {
			result.recovery = skill.recover(ctx, result) ?? null;
		} catch (e) {
			warn("skill", `${id}.recover threw: ${e.message}`);
		}
	}
	info("skill", `${id} → ${result.code}${result.detail ? ` (${JSON.stringify(result.detail).slice(0, 80)})` : ""}`);
	return result;
}

// For tests: lets a unit test register a synthetic skill without touching
// the production registry. Returns a teardown function.
export function _registerForTest(skill) {
	register(skill);
	return () => SKILLS.delete(skill.id);
}
