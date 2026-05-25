// Reflex layer: priority-ordered list of pure-script behaviors. Each reflex
// inspects the latest snapshot and either returns a no-op, dispatches an
// async action via ctx.dispatch, or completes synchronously.
//
// LLM is NOT called here. If every reflex declines, the tick yields and we
// try again next interval. The bot.js layer tracks consecutive noops and
// escalates to Pi after a threshold (see ESCALATE_AFTER_NOOPS).

import { info, warn } from "./log.js";
import {
	attackNearest,
	fleeFrom,
	eatBestFood,
	sleepInBed,
	goTo,
	chopNearestTree,
	wander,
	craftPlanks,
	craftSticks,
	placeCraftingTable,
	craftWoodenAxe,
	craftWoodenPickaxe,
	craftWoodenSword,
	inv,
} from "./actions.js";

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

// ---- autonomous "live your best life" --------------------------------------

// Triggered when no reactive reflex (operator/defend/eat/sleep) wants to act.
// Picks ONE small proactive action and runs it. Cooldown so we don't fire on
// every 3s tick — actions take 15-45s themselves and we want some breathing
// room between them.
const AUTONOMOUS_COOLDOWN_MS = 10_000;

function autonomousReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };

	// Only suppress autonomous work at night when a hostile is in actual reach
	// (within 16m). Distant mobs the perception layer happens to enumerate
	// don't count — at this spawn there can be 80+ mobs visible but irrelevant
	// to local action.
	const nightClose = !s.isDay && s.closestHostile && s.closestHostile.distance <= 16;
	if (nightClose) return { action: "noop" };

	const since = Date.now() - (ctx.lastAutonomousAt ?? 0);
	if (since < AUTONOMOUS_COOLDOWN_MS) return { action: "noop" };
	ctx.lastAutonomousAt = Date.now();

	// What to do: gather wood until we have a small stockpile, then wander a
	// bit to find new chunks. If a recent chop attempt reported "no reachable
	// log", switch to wander for the next 60s — chopping the same not-found
	// position over and over is what the user observed live.
	const inv = s.inventory ?? {};
	const logCount = Object.entries(inv)
		.filter(([name]) => name.endsWith("_log"))
		.reduce((sum, [, n]) => sum + n, 0);

	const noTreesRecently = ctx.noTreesUntil && Date.now() < ctx.noTreesUntil;
	const wantChop = logCount < 16 && !noTreesRecently;
	if (wantChop) {
		ctx.dispatch(() => chopNearestTree(ctx.bot), "chop tree", {
			onComplete: (res) => {
				if (res.ok) {
					info(REFLEX_LOG, `chopped ${res.detail?.logType ?? "log"}`);
					ctx.noTreesUntil = 0; // success ⇒ trees exist around us
				} else if (typeof res.detail === "string" && res.detail.includes("no reachable")) {
					// No log within 32 blocks of the current position. Don't try
					// again for 60s — wander first to find a new biome / chunk.
					ctx.noTreesUntil = Date.now() + 60_000;
				}
			},
		});
		return { action: "dispatched", kind: "autonomous-chop", label: "chop tree" };
	}
	ctx.dispatch(() => wander(ctx.bot, 16), "wander", {});
	return { action: "dispatched", kind: "autonomous-wander", label: "wander" };
}

// ---- tech-tree progression -------------------------------------------------
//
// Scripted progression toward the long-term goal (small farm + village). Runs
// between the autonomous wood-gathering reflex and idle. Order:
//   1. have ≥4 logs but 0 planks  → craft planks
//   2. have ≥2 planks but 0 sticks → craft sticks
//   3. have planks+sticks but no axe → craft wooden_axe (places a table)
//   4. have axe but no pickaxe → craft wooden_pickaxe
//   5. have pickaxe but no sword → craft wooden_sword
//   6. tools done — fall through to autonomous (chop more, then mine stone)
//
// Each step is cheap and idempotent: if it can't act it returns noop.

const TECH_TREE_COOLDOWN_MS = 5_000;

function techTreeReflex(ctx) {
	const s = ctx.snapshot;
	if (!s.connected) return { action: "noop" };
	if (!ctx.bot) return { action: "noop" };

	const since = Date.now() - (ctx.lastTechTreeAt ?? 0);
	if (since < TECH_TREE_COOLDOWN_MS) return { action: "noop" };

	const logs = inv.getAnyLogCount(ctx.bot);
	const planks = inv.getAnyPlanksCount(ctx.bot);
	const sticks = inv.getItemCount(ctx.bot, "stick");
	const hasAxe = ["wooden_axe", "stone_axe", "iron_axe", "diamond_axe", "netherite_axe"].some(
		(n) => inv.getItemCount(ctx.bot, n) > 0,
	);
	const hasPickaxe = [
		"wooden_pickaxe",
		"stone_pickaxe",
		"iron_pickaxe",
		"diamond_pickaxe",
		"netherite_pickaxe",
	].some((n) => inv.getItemCount(ctx.bot, n) > 0);
	const hasSword = ["wooden_sword", "stone_sword", "iron_sword", "diamond_sword", "netherite_sword"].some(
		(n) => inv.getItemCount(ctx.bot, n) > 0,
	);

	// Step 1: planks
	if (logs >= 1 && planks < 4) {
		ctx.lastTechTreeAt = Date.now();
		ctx.dispatch(() => craftPlanks(ctx.bot, 4), "craft planks");
		return { action: "dispatched", kind: "tech-planks", label: `planks (have ${planks}/4)` };
	}
	// Step 2: sticks
	if (planks >= 2 && sticks < 4) {
		ctx.lastTechTreeAt = Date.now();
		ctx.dispatch(() => craftSticks(ctx.bot, 4), "craft sticks");
		return { action: "dispatched", kind: "tech-sticks", label: `sticks (have ${sticks}/4)` };
	}
	// Step 3: axe
	if (planks >= 3 && sticks >= 2 && !hasAxe) {
		ctx.lastTechTreeAt = Date.now();
		ctx.dispatch(() => craftWoodenAxe(ctx.bot), "craft wooden_axe");
		return { action: "dispatched", kind: "tech-axe", label: "wooden_axe" };
	}
	// Step 4: pickaxe
	if (planks >= 3 && sticks >= 2 && hasAxe && !hasPickaxe) {
		ctx.lastTechTreeAt = Date.now();
		ctx.dispatch(() => craftWoodenPickaxe(ctx.bot), "craft wooden_pickaxe");
		return { action: "dispatched", kind: "tech-pickaxe", label: "wooden_pickaxe" };
	}
	// Step 5: sword
	if (planks >= 2 && sticks >= 1 && hasAxe && hasPickaxe && !hasSword) {
		ctx.lastTechTreeAt = Date.now();
		ctx.dispatch(() => craftWoodenSword(ctx.bot), "craft wooden_sword");
		return { action: "dispatched", kind: "tech-sword", label: "wooden_sword" };
	}

	return { action: "noop" };
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
	{ name: "tech-tree", fn: techTreeReflex },
	{ name: "autonomous", fn: autonomousReflex },
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
