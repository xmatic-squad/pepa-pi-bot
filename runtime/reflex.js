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
import { consult as consultAdvice, reportOutcome as reportAdviceOutcome } from "./coach/advice.js";
import { tickAdvisor, consumeFreshRecommendation } from "./coach/advisor-trigger.js";
import { markRecommendationApplied, markRecommendationOutcome } from "./knowledge/index.js";
import { pickActiveNeed } from "./manifesto/state.js";
import { pickCurrentStep } from "./goal/state.js";
import { observe as observeWedge, isWedged } from "./awareness/wedge-detector.js";
import { situationHash } from "./scenario-memory.js";
import { tickModes } from "./modes.js";

// Each "wander hint" triggered by a skill returning no_target should take
// the bot meaningfully further than 16 blocks — otherwise the curriculum
// re-fires the same skill, gets no_target again, and the bot loops in
// place. We escalate every other wander hint into explore.far (~48
// blocks, quadrant-rotating).
let consecutiveWanderHints = 0;

const REFLEX_LOG = "reflex";

const DEFEND_ATTACK_MAX_SWINGS = 5;
const DEFEND_ATTACK_SETTLE_MS = 650;
const DEFEND_CLEAR_RADIUS = 4.5;
const DEFEND_STUCK_WINDOW_MS = 20_000;
const DEFEND_REPEAT_OK_RETREAT_COUNT = 2;

// A reflex returns one of:
//   { action: "noop" }                       — nothing to do
//   { action: "dispatched", kind, label }    — dispatched an async action
//   { action: "completed", kind, detail }    — fully sync, already done
// Reflexes must NEVER throw — they log and return noop on failure.

// ---- defend ----------------------------------------------------------------

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function nearestHostileDistance(bot, hostileName) {
	const here = bot?.entity?.position;
	if (!here) return null;
	let nearest = null;
	for (const e of Object.values(bot.entities ?? {})) {
		if (!e?.position) continue;
		if (hostileName && e.name !== hostileName) continue;
		let dist;
		try {
			dist = e.position.distanceTo(here);
		} catch {
			continue;
		}
		if (!Number.isFinite(dist)) continue;
		if (nearest === null || dist < nearest) nearest = dist;
	}
	return nearest;
}

function distanceDetail(dist) {
	return Number.isFinite(dist) ? Number(dist.toFixed(1)) : dist;
}

async function attackNearestUntilClear(bot, hostileName, opts = {}) {
	if (!bot?.entity?.position) return { ok: false, code: "no_bot", detail: "bot missing position" };
	const maxSwings = Math.max(1, opts.maxSwings ?? DEFEND_ATTACK_MAX_SWINGS);
	const settleMs = Math.max(0, opts.settleMs ?? DEFEND_ATTACK_SETTLE_MS);
	let lastDetail = null;

	for (let swings = 0; swings < maxSwings; swings++) {
		const before = nearestHostileDistance(bot, hostileName);
		if (before === null || before > DEFEND_CLEAR_RADIUS) {
			return { ok: true, code: "done", detail: { target: hostileName, cleared: true, swings } };
		}

		const res = await attackNearest(bot, hostileName);
		lastDetail = res?.detail ?? null;
		if (!res?.ok) {
			return {
				ok: false,
				code: res?.code ?? "no_target",
				detail: res?.detail ?? "no target in reach",
			};
		}
		if (settleMs > 0) await delay(settleMs);
	}

	const after = nearestHostileDistance(bot, hostileName);
	if (after === null || after > DEFEND_CLEAR_RADIUS) {
		return { ok: true, code: "done", detail: { target: hostileName, cleared: true, swings: maxSwings } };
	}
	return {
		ok: false,
		code: "hostile_still_near",
		detail: {
			target: hostileName,
			distance: distanceDetail(after),
			swings: maxSwings,
			last: lastDetail,
		},
	};
}

function rememberDefendAttack(ctx, hostileName, res) {
	const now = Date.now();
	if (res?.ok) {
		const prev = ctx.defendAttackCleared;
		const count = prev?.name === hostileName && now - prev.ts < DEFEND_STUCK_WINDOW_MS
			? prev.count + 1
			: 1;
		ctx.defendAttackCleared = { name: hostileName, count, ts: now };
		if (ctx.defendAttackStuck?.name === hostileName) ctx.defendAttackStuck = null;
		return;
	}
	ctx.defendAttackCleared = null;
	if (res?.code !== "hostile_still_near") return;
	const prev = ctx.defendAttackStuck;
	const count = prev?.name === hostileName && now - prev.ts < DEFEND_STUCK_WINDOW_MS
		? prev.count + 1
		: 1;
	ctx.defendAttackStuck = { name: hostileName, count, ts: now };
}

function shouldRetreatFromStuckAttack(ctx, hostileName) {
	const stuck = ctx.defendAttackStuck;
	if (!stuck || stuck.name !== hostileName) return false;
	return stuck.count >= 1 && Date.now() - stuck.ts < DEFEND_STUCK_WINDOW_MS;
}

function shouldRetreatFromRepeatedClear(ctx, hostileName) {
	const cleared = ctx.defendAttackCleared;
	if (!cleared || cleared.name !== hostileName) return false;
	return cleared.count >= DEFEND_REPEAT_OK_RETREAT_COUNT && Date.now() - cleared.ts < DEFEND_STUCK_WINDOW_MS;
}

function matchingHostileEntity(ctx, hostileName, dist) {
	return Object.values(ctx.bot?.entities ?? {}).find(
		(e) =>
			e.name === hostileName &&
			e.position &&
			Math.abs(e.position.distanceTo(ctx.bot.entity.position) - dist) < 1.5,
	);
}

function dispatchDefendFlee(ctx, hostile, dist, opts = {}) {
	const lastFlee = ctx.lastFleeAttempt;
	if (!opts.ignoreCooldown && lastFlee && lastFlee.name === hostile.name && Date.now() - lastFlee.ts < 60_000) {
		return { action: "noop" };
	}
	ctx.lastFleeAttempt = { name: hostile.name, ts: Date.now() };

	const fromEntity = matchingHostileEntity(ctx, hostile.name, dist);
	const onComplete = opts.lessonId
		? (res) => reportAdviceOutcome({ lessonId: opts.lessonId, succeeded: !!res?.ok })
		: undefined;
	ctx.dispatch(
		() => fleeFrom(ctx.bot, fromEntity, 16),
		`flee from ${hostile.name}`,
		onComplete ? { onComplete } : {},
	);
	return { action: "dispatched", kind: "defend-flee", label: hostile.name };
}

function defendReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (!s.closestHostile) return { action: "noop" };

	const hostile = s.closestHostile;
	const dist = hostile.distance;
	const lowHp = (s.health ?? 20) <= 8;

	// Three regimes — tightened to avoid the "82 distant hostiles → constant
	// flee" pathology observed at this spawn:
	//   - within 4m: verified melee attack (do not report success while the
	//     hostile is still standing in reach)
	//   - within 8m (and visibly hostile to us): flee
	//   - low-HP fallback: flee anything within 12m
	// Anything beyond 8m with full HP is ignored regardless of how many
	// hostiles the perceive snapshot enumerates.
	if (dist <= 4) {
		if (shouldRetreatFromRepeatedClear(ctx, hostile.name)) {
			ctx.defendAttackCleared = null;
			return dispatchDefendFlee(ctx, hostile, dist, { ignoreCooldown: true });
		}
		if (shouldRetreatFromStuckAttack(ctx, hostile.name)) {
			ctx.defendAttackStuck = null;
			return dispatchDefendFlee(ctx, hostile, dist, { ignoreCooldown: true });
		}
		// v0.2.0 — consult learned lessons. If knowledge says "do not
		// attack <hostile> in this state" (e.g. creeper rule, or no-weapon
		// rule learned from post-mortems), flee instead. The lesson outcome
		// is reported AFTER the flee skill finishes (via dispatchDefendFlee
		// onComplete), not before — flee's success/failure is what proves
		// or disproves the lesson, not the act of consulting it. This is
		// the closing of the learning loop for emergency combat.
		const advice = consultAdvice({ plannedSkillId: `attack ${hostile.name}`, snapshot: s });
		if (advice.action === "avoid" || advice.action === "override") {
			return dispatchDefendFlee(ctx, hostile, dist, {
				ignoreCooldown: true,
				lessonId: advice.lessonId,
			});
		}
		ctx.dispatch(
			() => attackNearestUntilClear(ctx.bot, hostile.name, {
				maxSwings: ctx.defendAttackMaxSwings,
				settleMs: ctx.defendAttackSettleMs,
			}),
			`attack ${hostile.name}`,
			{ onComplete: (res) => rememberDefendAttack(ctx, hostile.name, res) },
		);
		return { action: "dispatched", kind: "defend-attack", label: hostile.name };
	}
	const shouldFlee = (dist <= 8) || (lowHp && dist <= 12);
	if (!shouldFlee) return { action: "noop" };

	// Cooldown — if we just fled from this same mob type and it didn't work
	// (timed out), don't immediately re-fire. Let other reflexes run.
	return dispatchDefendFlee(ctx, hostile, dist);
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
const METRIC_BACKOFF_MS = 10 * 60_000;
const METRIC_BAD_CODES = new Set(["timeout", "failed", "wedged", "silent_dig_failure", "validation_failed"]);

function isRecentBadMetric(metric, { minFails = 2, maxAgeMs = METRIC_BACKOFF_MS } = {}) {
	if (!metric) return false;
	if ((metric.fail ?? 0) < minFails) return false;
	if (!METRIC_BAD_CODES.has(metric.lastCode)) return false;
	if ((metric.ok ?? 0) > 0 && metric.lastCode !== "timeout") return false;
	return Date.now() - (metric.lastTs ?? 0) < maxAgeMs;
}

function recentSuccessAfter(metric, ts) {
	if (!metric || !ts) return false;
	if ((metric.ok ?? 0) <= 0) return false;
	return (metric.lastTs ?? 0) > ts && metric.lastCode === "done";
}

function metricRecoverySkill(ctx, plannedSkillId) {
	let metrics = null;
	try {
		metrics = ctx.metrics?.snapshot?.() ?? null;
	} catch {
		return null;
	}
	if (!metrics) return null;
	const badExplore = isRecentBadMetric(metrics["explore.far"], { minFails: 1 });
	const badWander = isRecentBadMetric(metrics.wander, { minFails: 2 });
	const lastMovementBadTs = Math.max(
		badExplore ? (metrics["explore.far"]?.lastTs ?? 0) : 0,
		badWander ? (metrics.wander?.lastTs ?? 0) : 0,
	);
	if ((badExplore || badWander) && !recentSuccessAfter(metrics["recovery.tunnel-out"], lastMovementBadTs)) {
		return { skillId: "recovery.tunnel-out", reason: "recent movement recovery failures" };
	}
	if (plannedSkillId && isRecentBadMetric(metrics[plannedSkillId], { minFails: 2 })) {
		return { skillId: "explore.far", reason: `${plannedSkillId} recently failed repeatedly` };
	}
	return null;
}

function checkSkillPreconditions(ctx, skillId, args = {}) {
	const skill = getSkill(skillId);
	if (!skill) return { ok: false, code: "unknown_skill", detail: skillId };
	try {
		return skill.preconditions(ctx, args) ?? { ok: true };
	} catch (e) {
		return { ok: false, code: "precondition_failed", detail: e?.message ?? String(e) };
	}
}

function resolveAdvisorSkill(ctx, rec, currentSkillId) {
	if (!rec?.skillId) return null;
	const pre = checkSkillPreconditions(ctx, rec.skillId);
	if (pre.ok) return rec.skillId;

	// The most common stale/under-specified advice is "switch to local
	// acquire-food" when no passive mob exists in the entity horizon.
	// Treat that as the broader food-search intent and route to scout-food.
	if (rec.skillId === "survive.acquire-food" && pre.code === "no_target") {
		const scoutPre = checkSkillPreconditions(ctx, "survive.scout-food");
		if (scoutPre.ok) {
			info(REFLEX_LOG, `advisor correction: ${rec.skillId} has no local target; using survive.scout-food`);
			return "survive.scout-food";
		}
	}

	info(
		REFLEX_LOG,
		`advisor ignored: ${currentSkillId} → ${rec.skillId} failed preconditions (${pre.code}: ${String(pre.detail ?? "").slice(0, 80)})`,
	);
	return null;
}

// v0.2.0-rc.3 — wedged-emergency escape. When the bot has not made
// meaningful horizontal progress for ≥ 60s AND there's no immediate
// hostile (defendReflex would have handled it) AND a placeable block
// is in inventory, dispatch survive.pillar-up to climb vertically out
// of pit terrain. Breaks the tunnel-out-fail-fall-back-to-flee loop
// observed live in the rc.2 deploy. noProgressReason is a hint, not
// required — pillar-up only writes blocks underneath, so even if the
// real cause is something else, the worst case is +1 dirt placed.
const WEDGED_MIN_MS = 60_000;

function wedgedEscapeSkill(ctx) {
	const s = ctx.snapshot;
	if (!s) return null;
	if (s.closestHostile && (s.closestHostile.distance ?? Infinity) < 6) return null;
	const lastMove = ctx.lastSignificantMoveAt ?? 0;
	if (!lastMove) return null; // need at least one tick of position tracking
	if (Date.now() - lastMove < WEDGED_MIN_MS) return null;
	// Last attempted escape was recent? give it room.
	if (ctx.skillBackoff?.["survive.pillar-up"] && Date.now() < ctx.skillBackoff["survive.pillar-up"]) {
		return null;
	}
	const pillar = getSkill("survive.pillar-up");
	if (!pillar) return null;
	const pre = pillar.preconditions(ctx);
	if (!pre.ok) return null;
	return "survive.pillar-up";
}

function trackSignificantMovement(ctx) {
	const s = ctx.snapshot;
	const pos = s?.position;
	if (!pos) return;
	const last = ctx.lastSignificantPos;
	if (!last) {
		ctx.lastSignificantPos = { x: pos.x, z: pos.z };
		ctx.lastSignificantMoveAt = Date.now();
		return;
	}
	const dx = pos.x - last.x;
	const dz = pos.z - last.z;
	if (dx * dx + dz * dz >= 16) {
		ctx.lastSignificantPos = { x: pos.x, z: pos.z };
		ctx.lastSignificantMoveAt = Date.now();
	}
}

function curriculumReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (!ctx.bot) return { action: "noop" };

	const since = Date.now() - (ctx.lastCurriculumAt ?? 0);
	if (since < CURRICULUM_COOLDOWN_MS) return { action: "noop" };

	trackSignificantMovement(ctx);
	const wedged = wedgedEscapeSkill(ctx);
	if (wedged) {
		ctx.lastCurriculumAt = Date.now();
		ctx.skillBackoff = ctx.skillBackoff ?? {};
		// Don't pillar-up every tick — cool off for 2 min after each attempt.
		ctx.skillBackoff["survive.pillar-up"] = Date.now() + 2 * 60_000;
		ctx.dispatch(() => runSkill(wedged, ctx), wedged, {});
		return { action: "dispatched", kind: "curriculum-wedged-escape", label: wedged };
	}

	const plan = s.curriculum?.plan;
	const wanderHintUntil = ctx.skillBackoff?.["__wander_hint__"] ?? 0;
	const wantWander = wanderHintUntil && Date.now() < wanderHintUntil;
	const scoutFoodHintUntil = ctx.skillBackoff?.["__scout_food_hint__"] ?? 0;
	const wantScoutFood = scoutFoodHintUntil && Date.now() < scoutFoodHintUntil;
	const relocateHintUntil = ctx.skillBackoff?.["__relocate_hint__"] ?? 0;
	const wantRelocate = relocateHintUntil && Date.now() < relocateHintUntil;

	// v0.3.0-rc.2 — manifesto layer. Walk the L0-L10 needs ladder; the
	// lowest unsatisfied need dictates the planned skill. The curriculum
	// plan is used as a fallback when the manifesto has nothing concrete
	// (e.g. armour pursue=null, or village_full with no specific next
	// step). This is what makes the bot pursue tangible intermediate
	// goals (tools_wood → shelter → tools_stone → ...) instead of
	// wandering in the same quadrant.
	//
	// Tests can pass ctx.disableManifesto=true to exercise the curriculum
	// branch in isolation without having to construct a full snapshot.
	const activeNeed = ctx.disableManifesto ? null : pickActiveNeed(s);
	if (activeNeed) {
		ctx.activeNeed = activeNeed;
	}
	const manifestoSkillId = activeNeed?.skillId ?? null;

	// v0.3.1 — wedge detector. Feeds position into rolling-bbox tracker.
	// When bot has been stuck in a <50-block bbox for 10 minutes with
	// the same need cycling its skills, returns wedged=true and we
	// short-circuit to village.relocate which walks 300 blocks in a
	// fresh cardinal. Tests pass ctx.disableWedge=true to skip.
	if (!ctx.disableWedge && s.position) {
		observeWedge({
			x: s.position.x, z: s.position.z,
			activeNeedId: activeNeed?.need?.id ?? null,
			recentSkillIds: ctx.recentSkillIds ?? [],
		});
		const wedge = isWedged({
			activeNeedId: activeNeed?.need?.id ?? null,
			recentSkillIds: ctx.recentSkillIds ?? [],
		});
		if (wedge.wedged) {
			ctx.lastCurriculumAt = Date.now();
			info(REFLEX_LOG, `wedged: bbox=${Math.round(wedge.bboxDim)}b need=${activeNeed?.need?.id} for ${Math.round(wedge.needAgeMs / 1000)}s → village.relocate`);
			ctx.dispatch(() => runSkill("village.relocate", ctx), "village.relocate", {});
			return { action: "dispatched", kind: "wedge-relocate", label: "village.relocate" };
		}
	}

	// v0.3.1 — storyline: the canonical Minecraft survival quest. Gives
	// the bot a concrete, narratable next-action ("collect 8 logs",
	// "place crafting table"). Storyline yields to manifesto on L0
	// alive emergencies but otherwise its suggestion is preferred over
	// the curriculum plan when it picks a registered skill.
	const storyStep = ctx.disableStoryline ? null : pickCurrentStep(s);
	if (storyStep) ctx.storyStep = storyStep;
	const storySkillId = (storyStep && !storyStep.emergency && storyStep.suggestion?.skillId) ? storyStep.suggestion.skillId : null;

	// v0.4.0 — Settlement Contract is the unified progression authority,
	// replacing the storyline rail (which competed with the manifesto). It is
	// precomputed in bot.js (snapshot.contract) via the GoalManager: lowest
	// unmet milestone, with food-urgency utility preemption. Manifesto L0
	// (alive emergencies) still preempts it; storyline/curriculum remain as
	// fallbacks when the contract is disabled (tests) or has no suggestion.
	const contractGoal = ctx.disableContract ? null : (s.contract ?? null);
	if (contractGoal) ctx.contractGoal = contractGoal;
	const contractSkillId = (contractGoal && !contractGoal.done && contractGoal.suggestedSkill?.skillId)
		? contractGoal.suggestedSkill.skillId
		: null;
	const metricRecovery = metricRecoverySkill(ctx, plan?.skillId);
	if (metricRecovery) {
		ctx.lastCurriculumAt = Date.now();
		ctx.skillBackoff = ctx.skillBackoff ?? {};
		if (plan?.skillId) ctx.skillBackoff[plan.skillId] = Date.now() + SKILL_BACKOFF_MS;
		const args = metricRecovery.skillId === "recovery.tunnel-out"
			? { reason: metricRecovery.reason, maxSteps: 3 }
			: {};
		ctx.dispatch(() => runSkill(metricRecovery.skillId, ctx, args), metricRecovery.skillId, {});
		return {
			action: "dispatched",
			kind: "curriculum-metric-recovery",
			label: metricRecovery.skillId,
		};
	}
	if (s.curriculum?.inventoryFull) {
		const depositId = s.locations?.chest || s.nearbyBlocks?.storage ? "village.deposit-surplus" : null;
		if (depositId) {
			const depositBackoff = ctx.skillBackoff?.[depositId] ?? 0;
			if (Date.now() >= depositBackoff) {
				ctx.lastCurriculumAt = Date.now();
				ctx.dispatch(() => runSkill(depositId, ctx), depositId, {
					onComplete: (res) => {
						if (!res?.ok) {
							ctx.skillBackoff = ctx.skillBackoff ?? {};
							ctx.skillBackoff[depositId] = Date.now() + SKILL_BACKOFF_MS;
						}
					},
				});
				return { action: "dispatched", kind: "curriculum-deposit", label: depositId };
			}
		}
	}

	if (wantRelocate || wantScoutFood) {
		ctx.lastCurriculumAt = Date.now();
		ctx.skillBackoff = ctx.skillBackoff ?? {};
		const hintSkillId = wantRelocate ? "village.relocate" : "survive.scout-food";
		const hintKey = wantRelocate ? "__relocate_hint__" : "__scout_food_hint__";
		ctx.skillBackoff[hintKey] = 0;
		const pre = checkSkillPreconditions(ctx, hintSkillId);
		if (pre.ok) {
			ctx.dispatch(() => runSkill(hintSkillId, ctx), hintSkillId, {});
			return {
				action: "dispatched",
				kind: wantRelocate ? "curriculum-recovery-relocate" : "curriculum-recovery-scout-food",
				label: hintSkillId,
			};
		}
		info(REFLEX_LOG, `recovery hint ${hintSkillId} skipped (${pre.code}: ${String(pre.detail ?? "").slice(0, 80)})`);
	}

	// No skill plan from curriculum OR a recent skill asked us to wander.
	// First hint → small wander (might just be 32-block reach issue).
	// Every subsequent hint while still inside the backoff window → use
	// explore.far so the bot actually leaves the patch it's stuck in.
	if ((!plan?.skillId && !manifestoSkillId && !storySkillId && !contractSkillId) || wantWander) {
		ctx.lastCurriculumAt = Date.now();
		const fallbackId = wantWander && consecutiveWanderHints >= 1 ? "explore.far" : "wander";
		// v0.2.0-rc.3 — consult advice on the FALLBACK dispatch too. Without
		// this, Pi-coach lessons like "do not explore.far after a zombie
		// sighting" never fire (the bot keeps falling into the fallback path
		// after each curriculum skill bails on no_target / wander_hint).
		const fbAdvice = consultAdvice({ plannedSkillId: fallbackId === "wander" ? "explore.far" : fallbackId, snapshot: ctx.snapshot });
		if (fbAdvice.action === "override" && fbAdvice.overrideSkillId) {
			ctx.dispatch(() => runSkill(fbAdvice.overrideSkillId, ctx), fbAdvice.overrideSkillId, {
				onComplete: (res) => reportAdviceOutcome({ lessonId: fbAdvice.lessonId, succeeded: !!res?.ok }),
			});
			return { action: "dispatched", kind: "curriculum-fallback-advice-override", label: fbAdvice.overrideSkillId, lessonId: fbAdvice.lessonId };
		}
		if (fbAdvice.action === "avoid") {
			// Lesson says don't do the fallback either. Try pillar-up as a
			// constructive last resort if we have a placeable block — otherwise
			// just idle for a tick so the next loop can re-evaluate.
			const pillarSkill = getSkill("survive.pillar-up");
			if (pillarSkill && pillarSkill.preconditions(ctx).ok) {
				ctx.dispatch(() => runSkill("survive.pillar-up", ctx), "survive.pillar-up", {
					onComplete: (res) => reportAdviceOutcome({ lessonId: fbAdvice.lessonId, succeeded: !!res?.ok }),
				});
				return { action: "dispatched", kind: "curriculum-fallback-pillar-up", label: "survive.pillar-up", lessonId: fbAdvice.lessonId };
			}
			return { action: "noop", kind: "curriculum-fallback-advice-avoid", label: fallbackId, lessonId: fbAdvice.lessonId };
		}
		if (fallbackId === "explore.far") {
			ctx.dispatch(() => runSkill("explore.far", ctx), "explore.far", {});
			return { action: "dispatched", kind: "curriculum-explore-far", label: "explore.far" };
		}
		ctx.dispatch(() => wander(ctx.bot, 16), "wander", {});
		return { action: "dispatched", kind: "curriculum-wander", label: "wander" };
	}

	// Pick what to dispatch. Order:
	//   1. manifesto L0 (alive emergencies: low HP near hostile, lava
	//      under foot, food=0) — absolute priority; do NOT let
	//      storyline overrule a "you're dying" signal.
	//   2. storyline — concrete narrative subgoal ("collect 8 logs",
	//      "craft wooden pickaxe"). Beats manifesto L1+ because the
	//      ladder needs operational direction, not just "you need food
	//      → dispatch acquire-food forever".
	//   3. manifesto L1+ — fallback when storyline has no concrete
	//      pursue (e.g. armor levels with pursue=null).
	//   4. curriculum plan — legacy fallback.
	const manifestoEmergency = activeNeed?.need?.level === 0;
	let skillId, skillSource;
	if (manifestoEmergency) {
		skillId = manifestoSkillId ?? contractSkillId ?? storySkillId ?? plan?.skillId;
		skillSource = `manifesto:${activeNeed.need.id}`;
	} else if (contractSkillId) {
		skillId = contractSkillId;
		skillSource = `contract:${contractGoal.milestone.id}`;
	} else if (storySkillId) {
		skillId = storySkillId;
		skillSource = `storyline:${storyStep.step.id}`;
	} else {
		skillId = manifestoSkillId ?? plan?.skillId;
		skillSource = manifestoSkillId ? `manifesto:${activeNeed.need.id}` : "curriculum";
	}

	// v0.3.0 fast-advisor: if a fresh recommendation is sitting on ctx
	// (the result of a previous tick's async advise() call), use it.
	// This is the closing of the awareness → LLM → action loop.
	let appliedRecommendationId = null;
	if (!ctx.disableAdvisor) {
		const rec = consumeFreshRecommendation(ctx);
		if (rec && rec.skillId) {
			const resolved = resolveAdvisorSkill(ctx, rec, skillId);
			if (resolved) {
				info(REFLEX_LOG, `advisor override: ${skillId} → ${resolved} (${rec.triggerReason}, ${rec.rationale?.slice(0, 60)})`);
				skillId = resolved;
				skillSource = `advisor:${rec.triggerReason}`;
				appliedRecommendationId = rec.id ?? null;
				if (appliedRecommendationId) markRecommendationApplied(appliedRecommendationId);
			} else if (rec.id) {
				markRecommendationOutcome(rec.id, { ok: false, code: "precondition_failed" });
			}
		}
		// Always fire-and-forget another advise() if triggers fire — the
		// result lands on a future tick. tickAdvisor handles its own
		// cooldown / in-flight checks so this is safe to call every tick.
		tickAdvisor(ctx, { plannedSkillId: skillId });
	}

	const skill = getSkill(skillId);
	if (!skill) {
		// Suggested a skill that isn't registered yet — fall back
		// to wander rather than spinning. This is the right behaviour for
		// future milestones we haven't wired (e.g. shelter blueprints).
		ctx.lastCurriculumAt = Date.now();
		ctx.dispatch(() => wander(ctx.bot, 16), "wander", {});
		return { action: "dispatched", kind: "curriculum-wander", label: `wander (no skill ${skillId}; source ${skillSource})` };
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

	// v0.2.0 — consult learned lessons. If a high-confidence lesson says
	// "avoid <skillId> in this situation", swap to its preferred
	// alternative (or back off entirely if no safe alternative is named).
	const advice = consultAdvice({ plannedSkillId: skillId, snapshot: ctx.snapshot });
	let dispatchSkillId = skillId;
	if (advice.action === "avoid") {
		ctx.skillBackoff = ctx.skillBackoff ?? {};
		ctx.skillBackoff[skillId] = Date.now() + SKILL_BACKOFF_MS;
		ctx.skillBackoff["__wander_hint__"] = Date.now() + SKILL_BACKOFF_MS;
		return { action: "noop", kind: "curriculum-advice-avoid", label: skillId, lessonId: advice.lessonId };
	}
	if (advice.action === "override" && advice.overrideSkillId) {
		dispatchSkillId = advice.overrideSkillId;
	}

	ctx.lastCurriculumAt = Date.now();
	const dispatchArgs = (manifestoSkillId && manifestoSkillId === dispatchSkillId)
		? (activeNeed.args ?? {})
		: {};
	ctx.dispatch(() => runSkill(dispatchSkillId, ctx, dispatchArgs), dispatchSkillId, {
		onComplete: (res) => {
			ctx.skillBackoff = ctx.skillBackoff ?? {};
			if (advice.lessonId) reportAdviceOutcome({ lessonId: advice.lessonId, succeeded: !!res?.ok });
			if (appliedRecommendationId) {
				markRecommendationOutcome(appliedRecommendationId, {
					ok: !!res?.ok,
					code: res?.code ?? null,
				});
			}
			if (res?.recovery?.hint === "wander") {
				// Same fix the old autonomous reflex applied for "no reachable
				// log" — switch to exploration for a minute.
				ctx.skillBackoff["__wander_hint__"] = Date.now() + SKILL_BACKOFF_MS;
				consecutiveWanderHints++;
			}
			if (res?.recovery?.hint === "scout-food") {
				ctx.skillBackoff[dispatchSkillId] = Date.now() + SKILL_BACKOFF_MS;
				ctx.skillBackoff["__scout_food_hint__"] = Date.now() + SKILL_BACKOFF_MS;
			}
			if (res?.recovery?.hint === "relocate") {
				ctx.skillBackoff[dispatchSkillId] = Date.now() + SKILL_BACKOFF_MS;
				ctx.skillBackoff["__relocate_hint__"] = Date.now() + SKILL_BACKOFF_MS;
			}
			if (!res?.ok) {
				// missing_tool / missing_material / no_target shouldn't be
				// retried on the very next tick. Hold for SKILL_BACKOFF_MS.
				const cooldownCodes = new Set(["missing_tool", "missing_material", "no_target", "no_food_source", "unsupported_version", "no_chest", "no_space", "nothing_to_deposit"]);
				if (cooldownCodes.has(res?.code)) {
					ctx.skillBackoff[dispatchSkillId] = Date.now() + SKILL_BACKOFF_MS;
				}
			} else {
				// Success clears the wander hint immediately.
				ctx.skillBackoff["__wander_hint__"] = 0;
				consecutiveWanderHints = 0;
			}
		},
	});
	return { action: "dispatched", kind: "curriculum-skill", label: dispatchSkillId, source: skillSource };
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
	// Modes (Mindcraft-style priority chain) run BEFORE the legacy reflex
	// chain. Any mode with interrupts:["all"] wins outright; ones that only
	// interrupt the curriculum just steer us toward a particular skill via
	// runSkill. The reflex chain stays as the fallback for things the modes
	// don't cover yet.
	const modeHit = tickModes(ctx);
	if (modeHit?.action?.skillId) {
		const fn = () => runSkill(modeHit.action.skillId, ctx, modeHit.action.args ?? {});
		ctx.lastReflex = { name: `mode:${modeHit.mode}`, label: modeHit.action.skillId, ts: Date.now() };
		ctx.dispatch(fn, modeHit.action.skillId, {});
		return {
			reflex: `mode:${modeHit.mode}`,
			action: "dispatched",
			kind: `mode:${modeHit.mode}`,
			label: modeHit.action.skillId,
			detail: modeHit.detail,
		};
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
