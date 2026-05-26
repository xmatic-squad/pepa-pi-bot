// Reflex layer: priority-ordered behaviours that decide what the bot does
// each tick. The LLM is NOT called here. If every reflex declines, the tick
// yields and we try again next interval. The bot.js layer tracks consecutive
// noops and escalates to Pi after a threshold (see ESCALATE_AFTER_NOOPS).
//
// Chain (top to bottom — first to dispatch wins):
//
//   defend     event-driven, hostile in melee or low HP + close
//   eat        event-driven, food bar low
//   sleep      event-driven, night without hostile in reach
//   curriculum the new scheduler — reads snapshot.curriculum and dispatches
//              via runtime/skills/runSkill. Replaces the old ad-hoc
//              tech-tree + autonomous chop/wander branches.
//   idle       heartbeat logger
//
// Operator chat does NOT create tasks (Phase 0 pivot). TUI pause/stop is
// the only local override.

import { info, warn } from "./log.js";
import {
	attackNearest,
	fleeFrom,
	eatBestFood,
	sleepInBed,
	wander,
} from "./actions.js";
import { runSkill, getSkill } from "./skills/index.js";
import { situationHash } from "./scenario-memory.js";

// Each "wander hint" triggered by a skill returning no_target should take
// the bot meaningfully further than 16 blocks — otherwise the curriculum
// re-fires the same skill, gets no_target again, and the bot loops in
// place. We escalate every other wander hint into explore.far (~48
// blocks, quadrant-rotating).
let consecutiveWanderHints = 0;

const REFLEX_LOG = "reflex";

// A reflex returns one of:
//   { action: "noop" }                       — nothing to do
//   { action: "dispatched", kind, label }    — dispatched an async action
//   { action: "completed", kind, detail }    — fully sync, already done
// Reflexes must NEVER throw — they log and return noop on failure.

// ---- defend ----------------------------------------------------------------

function defendReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (!s.closestHostile) return { action: "noop" };

	const dist = s.closestHostile.distance;
	const lowHp = (s.health ?? 20) <= 8;

	// Three regimes — tightened to avoid the "82 distant hostiles → constant
	// flee" pathology observed at this spawn:
	//   - within 4m: melee attack
	//   - within 8m (and visibly hostile to us): flee
	//   - low-HP fallback: flee anything within 12m
	// Anything beyond 8m with full HP is ignored regardless of how many
	// hostiles the perceive snapshot enumerates.
	if (dist <= 4) {
		ctx.dispatch(
			() => attackNearest(ctx.bot, s.closestHostile.name),
			`attack ${s.closestHostile.name}`,
		);
		return { action: "dispatched", kind: "defend-attack", label: s.closestHostile.name };
	}
	const shouldFlee = (dist <= 8) || (lowHp && dist <= 12);
	if (!shouldFlee) return { action: "noop" };

	// Cooldown — if we just fled from this same mob type and it didn't work
	// (timed out), don't immediately re-fire. Let other reflexes run.
	const lastFlee = ctx.lastFleeAttempt;
	if (lastFlee && lastFlee.name === s.closestHostile.name && Date.now() - lastFlee.ts < 60_000) {
		return { action: "noop" };
	}
	ctx.lastFleeAttempt = { name: s.closestHostile.name, ts: Date.now() };

	const fromEntity = Object.values(ctx.bot.entities).find(
		(e) =>
			e.name === s.closestHostile.name &&
			e.position &&
			Math.abs(e.position.distanceTo(ctx.bot.entity.position) - dist) < 1.5,
	);
	ctx.dispatch(
		() => fleeFrom(ctx.bot, fromEntity, 16),
		`flee from ${s.closestHostile.name}`,
	);
	return { action: "dispatched", kind: "defend-flee", label: s.closestHostile.name };
}

// ---- eat -------------------------------------------------------------------

// Lightweight food allowlist — must match what eatBestFood actually tries.
// Kept inline so reflex doesn't have to import the groups module.
const EAT_REFLEX_FOOD = new Set([
	"cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken",
	"cooked_rabbit", "cooked_salmon", "cooked_cod", "baked_potato",
	"bread", "carrot", "apple", "sweet_berries", "melon_slice",
	"beef", "porkchop", "chicken", "mutton",
]);

function eatReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (s.food === undefined || s.food >= 16) return { action: "noop" };
	// Don't dispatch eat if there's literally no food in inventory — the
	// previous version dispatched every tick, got "no food in inventory" and
	// burned the whole reflex chain on a hopeless eat-spam. (Observed live
	// 2026-05-26.) The curriculum has food.basic as a real milestone now;
	// keep eat reflex strictly for "we have food, eat it" cases.
	const inv = s.inventory ?? {};
	const hasFood = Object.keys(inv).some((n) => EAT_REFLEX_FOOD.has(n));
	if (!hasFood) return { action: "noop" };
	// Cooldown on attempts (not only successes). Bot.consume has lag on the
	// server and re-firing within 5s would just fail. We update lastEatAt
	// on EVERY dispatch so a failed attempt also respects the cooldown.
	const since = Date.now() - (ctx.lastEatAt ?? 0);
	if (since < 5000) return { action: "noop" };
	ctx.lastEatAt = Date.now();
	ctx.dispatch(() => eatBestFood(ctx.bot), "eat", {});
	return { action: "dispatched", kind: "eat", label: `food=${s.food}` };
}

// ---- sleep -----------------------------------------------------------------

// Inventory check so the sleep reflex doesn't waste a dispatch when we
// have no bed AND no bed nearby — let the curriculum (survive.bed) drive
// bed acquisition instead. The action itself still re-checks, but pre-
// filtering here saves a dispatch + 5-min cooldown on impossible states.
const ANY_BED_NAME_RE = /(?:^|_)bed$/;
function hasAnyBedItem(inv) {
	return Object.keys(inv ?? {}).some((n) => ANY_BED_NAME_RE.test(n));
}

function sleepReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (s.isDay) return { action: "noop" };
	if (s.closestHostile && s.closestHostile.distance < 8) return { action: "noop" }; // not safe
	// Skip dispatch entirely when there is no bed in inventory AND no
	// placed bed location we know about. Otherwise every restart at night
	// burns a "sleep → no bed" dispatch+5-min cooldown for nothing — saw
	// this live 2026-05-26 where the bot would dispatch sleep right after
	// every spawn before doing anything productive.
	const bedItem = hasAnyBedItem(s.inventory);
	const bedLoc = s.locations?.shelter ?? s.locations?.base ?? null;
	if (!bedItem && !bedLoc) return { action: "noop" };
	// Longer cooldown after a failure — if there's no bed nearby, retrying
	// every 30s blocks autonomous behaviour without ever succeeding.
	const since = Date.now() - (ctx.lastSleepAttemptAt ?? 0);
	if (since < 5 * 60_000) return { action: "noop" };

	ctx.lastSleepAttemptAt = Date.now();
	ctx.dispatch(
		() => sleepInBed(ctx.bot),
		"sleep",
		{
			onComplete: (res) => {
				if (res.ok) info(REFLEX_LOG, `sleep: success (${JSON.stringify(res.detail)})`);
				else info(REFLEX_LOG, `sleep: declined (${res.detail})`);
			},
		},
	);
	return { action: "dispatched", kind: "sleep", label: "night" };
}

// ---- curriculum ------------------------------------------------------------
//
// The new scheduler. Reads snapshot.curriculum (produced by runtime/
// curriculum.js in bot.js's tick) and dispatches the suggested skill
// via runSkill. Falls back to wander when:
//   * no curriculum result (curriculum says "everything done — late game"),
//   * suggested skill is unknown to the registry,
//   * recent recover() hint asked us to wander (e.g. no_target from
//     gather.logs / gather.stone — same heuristic the old autonomous
//     reflex used).
//
// Stone-tier locks: gather.stone needs a pickaxe; the skill's own
// preconditions will reject otherwise. When that happens we record a
// short backoff so we don't dispatch-and-fail every tick.

const CURRICULUM_COOLDOWN_MS = 4_000;
const SKILL_BACKOFF_MS = 60_000;

function curriculumReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (!ctx.bot) return { action: "noop" };

	const since = Date.now() - (ctx.lastCurriculumAt ?? 0);
	if (since < CURRICULUM_COOLDOWN_MS) return { action: "noop" };

	const plan = s.curriculum?.plan;
	const wanderHintUntil = ctx.skillBackoff?.["__wander_hint__"] ?? 0;
	const wantWander = wanderHintUntil && Date.now() < wanderHintUntil;

	// No skill plan from curriculum OR a recent skill asked us to wander.
	// First hint → small wander (might just be 32-block reach issue).
	// Every subsequent hint while still inside the backoff window → use
	// explore.far so the bot actually leaves the patch it's stuck in.
	if (!plan?.skillId || wantWander) {
		ctx.lastCurriculumAt = Date.now();
		if (wantWander && consecutiveWanderHints >= 1) {
			ctx.dispatch(() => runSkill("explore.far", ctx), "explore.far", {});
			return { action: "dispatched", kind: "curriculum-explore-far", label: "explore.far" };
		}
		ctx.dispatch(() => wander(ctx.bot, 16), "wander", {});
		return { action: "dispatched", kind: "curriculum-wander", label: "wander" };
	}

	const skillId = plan.skillId;
	const skill = getSkill(skillId);
	if (!skill) {
		// Curriculum suggested a skill that isn't registered yet — fall back
		// to wander rather than spinning. This is the right behaviour for
		// future milestones we haven't wired (e.g. shelter blueprints).
		ctx.lastCurriculumAt = Date.now();
		ctx.dispatch(() => wander(ctx.bot, 16), "wander", {});
		return { action: "dispatched", kind: "curriculum-wander", label: `wander (no skill ${skillId})` };
	}

	// Per-skill backoff: if this exact skill failed with a non-recoverable
	// reason recently (missing_tool, missing_material, no_target) we give it
	// breathing room rather than retrying every cooldown.
	const backoffUntil = ctx.skillBackoff?.[skillId] ?? 0;
	if (Date.now() < backoffUntil) return { action: "noop" };

	// Scenario memory: this exact (skill, situation) pattern failed N times
	// recently? Skip and let the wander/explore hint move us to a different
	// situation. The hash includes coarse position + day/night + food + hp
	// + inventory keys + nearby hostile — "same kind of place + state".
	if (ctx.memory?.shouldSkip && ctx.snapshot) {
		const sit = situationHash(ctx.snapshot);
		if (ctx.memory.shouldSkip({ skillId, situation: sit })) {
			// Pretend a wander hint fired so the next tick will explore.
			ctx.skillBackoff = ctx.skillBackoff ?? {};
			ctx.skillBackoff["__wander_hint__"] = Date.now() + SKILL_BACKOFF_MS;
			return { action: "noop" };
		}
	}

	ctx.lastCurriculumAt = Date.now();
	ctx.dispatch(() => runSkill(skillId, ctx), skillId, {
		onComplete: (res) => {
			ctx.skillBackoff = ctx.skillBackoff ?? {};
			if (res?.recovery?.hint === "wander") {
				// Same fix the old autonomous reflex applied for "no reachable
				// log" — switch to exploration for a minute.
				ctx.skillBackoff["__wander_hint__"] = Date.now() + SKILL_BACKOFF_MS;
				consecutiveWanderHints++;
			}
			if (!res?.ok) {
				// missing_tool / missing_material / no_target shouldn't be
				// retried on the very next tick. Hold for SKILL_BACKOFF_MS.
				const cooldownCodes = new Set(["missing_tool", "missing_material", "no_target", "no_food_source", "unsupported_version"]);
				if (cooldownCodes.has(res?.code)) {
					ctx.skillBackoff[skillId] = Date.now() + SKILL_BACKOFF_MS;
				}
			} else {
				// Success clears the wander hint immediately.
				ctx.skillBackoff["__wander_hint__"] = 0;
				consecutiveWanderHints = 0;
			}
		},
	});
	return { action: "dispatched", kind: "curriculum-skill", label: skillId };
}

// ---- idle ------------------------------------------------------------------

function idleReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	ctx.idleCounter = (ctx.idleCounter ?? 0) + 1;
	if (ctx.idleCounter % 20 !== 0) return { action: "noop" };
	info(
		REFLEX_LOG,
		`idle: hp=${s.health} food=${s.food} pos=${s.position?.x},${s.position?.y},${s.position?.z} time=${s.time}`,
	);
	return { action: "completed", kind: "idle-heartbeat" };
}

const REFLEXES = [
	{ name: "defend", fn: defendReflex },
	{ name: "eat", fn: eatReflex },
	{ name: "sleep", fn: sleepReflex },
	{ name: "curriculum", fn: curriculumReflex },
	{ name: "idle", fn: idleReflex },
];

export function runTick(ctx) {
	// Bot is in the middle of an async action — don't dispatch another.
	if (ctx.busy) {
		return { reflex: "busy", action: "skipped", label: ctx.currentActionLabel ?? "(?)" };
	}
	for (const reflex of REFLEXES) {
		let outcome;
		try {
			outcome = reflex.fn(ctx);
		} catch (e) {
			warn(REFLEX_LOG, `reflex ${reflex.name} threw: ${e?.message ?? e}`);
			continue;
		}
		if (!outcome || outcome.action === "noop") continue;
		ctx.lastReflex = { name: reflex.name, label: outcome.label ?? outcome.kind, ts: Date.now() };
		return { reflex: reflex.name, ...outcome };
	}
	return null;
}

// Exposed for tests.
export const _internal = { curriculumReflex, defendReflex, eatReflex, sleepReflex };
