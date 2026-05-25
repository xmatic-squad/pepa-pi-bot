// Reflex layer: priority-ordered list of pure-script behaviors. Each reflex
// inspects the latest snapshot and either returns a no-op, dispatches an
// async action via ctx.dispatch, or completes synchronously.
//
// LLM is NOT called here. If every reflex declines, the tick yields and we
// try again next interval. The bot.js layer tracks consecutive noops and
// escalates to Pi after a threshold (see ESCALATE_AFTER_NOOPS).

import { info, warn } from "./log.js";
import { attackNearest, fleeFrom, eatBestFood, sleepInBed, goTo } from "./actions.js";

const REFLEX_LOG = "reflex";

// A reflex returns one of:
//   { action: "noop" }                       — nothing to do
//   { action: "dispatched", kind, label }    — dispatched an async action
//   { action: "completed", kind, detail }    — fully sync, already done
// Reflexes must NEVER throw — they log and return noop on failure.

// ---- operator goal reflex --------------------------------------------------

// Highest priority: if the operator gave a "come here" / "follow me" command,
// satisfy that before anything else (except defending if HP is critical).
function operatorGoalReflex(ctx) {
	const goal = ctx.operatorGoal;
	if (!goal) return { action: "noop" };
	if (goal.kind === "come") {
		ctx.dispatch(
			() => goTo(ctx.bot, goal.x, goal.y, goal.z, 2),
			`operator-come(${goal.from})`,
			{
				onComplete: (res) => {
					if (res.ok) {
						ctx.bot.chat(`${goal.from}: arrived.`);
					} else {
						ctx.bot.chat(`${goal.from}: couldn't reach you (${res.detail}).`);
					}
					ctx.clearOperatorGoal();
				},
			},
		);
		return { action: "dispatched", kind: "operator-come", label: `come ${goal.x},${goal.y},${goal.z}` };
	}
	return { action: "noop" };
}

// ---- defend ----------------------------------------------------------------

function defendReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (!s.closestHostile) return { action: "noop" };

	const dist = s.closestHostile.distance;
	const lowHp = (s.health ?? 20) <= 8;

	// Two regimes:
	//   - within 4m: melee attack
	//   - 4-12m and either low HP or many hostiles: flee
	if (dist <= 4) {
		ctx.dispatch(
			() => attackNearest(ctx.bot, s.closestHostile.name),
			`attack ${s.closestHostile.name}`,
		);
		return { action: "dispatched", kind: "defend-attack", label: s.closestHostile.name };
	}
	if (dist <= 12 && (lowHp || (s.hostileCount ?? 0) >= 3)) {
		const fromEntity = Object.values(ctx.bot.entities).find(
			(e) => e.name === s.closestHostile.name && e.position && Math.abs(e.position.distanceTo(ctx.bot.entity.position) - dist) < 1.5,
		);
		ctx.dispatch(
			() => fleeFrom(ctx.bot, fromEntity, 16),
			`flee from ${s.closestHostile.name}`,
		);
		return { action: "dispatched", kind: "defend-flee", label: s.closestHostile.name };
	}
	return { action: "noop" };
}

// ---- eat -------------------------------------------------------------------

function eatReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (s.food === undefined || s.food >= 16) return { action: "noop" };
	// Don't eat if we just ate (the food bar refresh on the server has a
	// small lag — re-firing within 5s would just fail bot.consume).
	const since = Date.now() - (ctx.lastEatAt ?? 0);
	if (since < 5000) return { action: "noop" };

	ctx.dispatch(
		() => eatBestFood(ctx.bot),
		"eat",
		{
			onComplete: (res) => {
				if (res.ok) ctx.lastEatAt = Date.now();
			},
		},
	);
	return { action: "dispatched", kind: "eat", label: `food=${s.food}` };
}

// ---- sleep -----------------------------------------------------------------

function sleepReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (s.isDay) return { action: "noop" };
	if (s.closestHostile && s.closestHostile.distance < 8) return { action: "noop" }; // not safe
	// Cooldown — don't retry sleep more than once per 30s if it failed.
	const since = Date.now() - (ctx.lastSleepAttemptAt ?? 0);
	if (since < 30_000) return { action: "noop" };

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
	{ name: "operator-goal", fn: operatorGoalReflex },
	{ name: "defend", fn: defendReflex },
	{ name: "eat", fn: eatReflex },
	{ name: "sleep", fn: sleepReflex },
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
		return { reflex: reflex.name, ...outcome };
	}
	return null;
}
