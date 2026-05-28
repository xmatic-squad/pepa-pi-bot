// Long-running Mineflayer process. Owns:
//   - the MC TCP connection + reconnect policy
//   - the reflex tick loop (no LLM in hot path)
//   - the IPC server for TUI clients
//   - on-demand Pi-headless escalation (manual or automatic)
//
// MC chat is dialog-only (see plans/autonomous-survival-bot-prd.md, FR1).
// Player/operator chat may produce a social reply but never dispatches a
// movement/build/mining task. TUI is the only local control plane.
//
// Lifecycle: started by `npm run bot`. Connects to MC, spawns IPC server,
// ticks every TICK_INTERVAL_SECONDS, broadcasts STATUS to clients each tick.
// SIGINT / SIGTERM: graceful disconnect + socket cleanup + exit.

import fs from "node:fs";
import path from "node:path";
import mineflayer from "mineflayer";

import { config, stateDir, redactedConfig } from "./config.js";
import { info, warn, error } from "./log.js";
import { snapshot as buildSnapshot } from "./perceive.js";
import { runTick } from "./reflex.js";
import { createIpcServer } from "./ipc-server.js";
import { askPi } from "./pi-bridge.js";
import { COMMAND_TYPES, EVENT_TYPES } from "./ipc-protocol.js";
import {
	readCurrentTask,
	writeCurrentTask,
	clearCurrentTask,
	appendDiary,
	writeProposal,
	listProposals,
	readProposal,
	approveProposal,
	writeEscalation,
	readDiaryTail,
} from "./state-store.js";
import { startAutoImprover } from "./auto-improve.js";
import { startPlanner, isPlannerBusy, readNextMilestone, planExists } from "./planner.js";
import { computeState, STATES } from "./state.js";
import { createNoProgressDetector } from "./no-progress.js";
import { maybeStartViewer } from "./viewer.js";
import { createPathfinderWatchdog } from "./pathfinder-watchdog.js";
import { nextMilestone as nextCurriculumMilestone } from "./curriculum.js";
import { listLocations } from "./locations.js";
import { runSkill } from "./skills/index.js";
import { classifyIntent, INTENTS } from "./social/intent.js";
import { generateReply } from "./social/reply.js";
import { createChatMemory } from "./social/memory.js";
import { appendChat as appendChatHistory } from "./social/chat-history.js";
import { piReply } from "./social/reply-pi.js";
import { openConversation, peekConversation, listConversations } from "./social/conversation.js";
import { takeScreenshot } from "./viewer.js";
import { createStuckIncidentDetector, attachCritique } from "./stuck-incident.js";
import { requestCritique } from "./critic.js";
import { createSkillMetrics } from "./skill-metrics.js";
import { createWorldJournal } from "./world-journal.js";
import { createScenarioMemory, situationHash } from "./scenario-memory.js";
import { createOwnedBlocksLedger } from "./owned-blocks.js";
import { createInventoryLedger } from "./services/inventory-ledger.js";
import { createMotionService } from "./services/motion.js";
import { createAntiLoop } from "./anti-loop.js";
import { initKnowledge } from "./knowledge/index.js";
import { attach as attachCoach } from "./coach/postmortem.js";
import { attach as attachReflect } from "./coach/reflect.js";
import { attach as attachTuner } from "./coach/trigger-tuner.js";
import { attach as attachChatter } from "./persona/chatter.js";
import { attachAwareness } from "./awareness/events.js";
import { pickCurrentStep } from "./goal/state.js";
import { createGoalManager } from "./goal/goal-manager.js";
import { computeVillageScore } from "./goal/village-score.js";

fs.mkdirSync(stateDir, { recursive: true });
const JOINED_FLAG = path.join(stateDir, "joined-before.flag");

// Knowledge subsystem boots in the background. If better-sqlite3 isn't
// installed the call returns false and every knowledge API becomes a
// safe no-op. See docs/v0.2.0-self-learning.md.
initKnowledge({ stateDir }).catch((e) => warn("knowledge", `init failed: ${e?.message ?? e}`));

// Auto-escalation tunables. With tick=3s, 20 noops ≈ 1 minute idle before we
// even consider asking Pi. Cooldown prevents spamming the LLM when the bot
// is permanently stuck on the same situation.
const ESCALATE_AFTER_NOOPS = 20;
const ESCALATION_COOLDOWN_MS = 10 * 60 * 1000;

let bot = null;
let botSpawnedAt = 0;
let pathWatchdog = null;
let awarenessState = null;
let reflexPaused = false;
let tickTimer = null;
let reconnectTimer = null;
let shuttingDown = false;
let lastSnapshot = { connected: false };

let consecutiveNoops = 0;
let lastEscalationAt = 0;

// Observability state — surfaced in every STATUS snapshot so the TUI (and
// future Telegram/diary surfaces) can answer "what is the bot doing and why
// isn't it doing more?" without parsing the log stream.
const noProgress = createNoProgressDetector();
const stuckIncident = createStuckIncidentDetector({
	thresholdMs: config.stuckThresholdMs,
	cooldownMs: config.stuckCooldownMs,
});
const skillMetrics = createSkillMetrics();
const worldJournal = createWorldJournal();
const scenarioMemory = createScenarioMemory();
const ownedBlocks = createOwnedBlocksLedger();
const inventoryLedger = createInventoryLedger();
const antiLoop = createAntiLoop();
const goalManager = createGoalManager();
let motionService = null; // armed on spawn (needs a live bot for pathfinder)
let lastResult = null; // { label, ok, code, detail, ts }
let lastFailureAt = 0;
let lastPlanReadAt = 0;
let cachedMilestone = null;
let cachedPlanExists = false;
const MILESTONE_CACHE_MS = 30_000;

// Reflex context — passed into reflex.js every tick. Mutable across ticks.
// Memory stores (journal + memory) live here so skill code can consult
// them directly — gather.* can preferentially target known log positions,
// deposit-surplus can mark the chest it placed, etc.
const reflexCtx = {
	bot: null,
	snapshot: lastSnapshot,
	busy: false,
	currentActionLabel: null,
	idleCounter: 0,
	lastEatAt: 0,
	lastSleepAttemptAt: 0,
	// Tracks repeated failure of the same labelled action — triggers a proposal.
	recentFailures: [], // [{label, detail, ts}], capped at 10
	dispatch: dispatchAction,
	journal: worldJournal,
	memory: scenarioMemory,
	metrics: skillMetrics,
	owned: ownedBlocks,
	ledger: inventoryLedger,
	antiLoop,
	motion: null, // set on spawn alongside the pathfinder watchdog
};

let chatTimestamps = [];
const CHAT_WINDOW_MS = 60_000;

let ipc;

// ---- chat rate limit -------------------------------------------------------

function chatRateAllowed() {
	const now = Date.now();
	chatTimestamps = chatTimestamps.filter((t) => now - t < CHAT_WINDOW_MS);
	if (chatTimestamps.length >= config.chatRateLimitPerMin) return false;
	chatTimestamps.push(now);
	return true;
}

function botChat(text) {
	if (!bot) return;
	if (!chatRateAllowed()) {
		warn("chat", `dropped chat (rate-limited): ${text.slice(0, 60)}`);
		return;
	}
	bot.chat(text);
}

// ---- auth ------------------------------------------------------------------

function hasJoinedBefore() {
	return fs.existsSync(JOINED_FLAG);
}

function markJoinedBefore() {
	try {
		fs.writeFileSync(JOINED_FLAG, new Date().toISOString());
	} catch (e) {
		warn("auth", `could not write joined flag: ${e.message}`);
	}
}

function maybeHandleAuthPrompt(text) {
	if (!bot || !config.authmePassword) return;
	const lower = text.toLowerCase();
	const sawRegister = lower.includes("/register");
	const sawLogin = lower.includes("/login");
	if (!sawRegister && !sawLogin) return;

	const cmd = sawLogin ? "login" : hasJoinedBefore() ? "login" : "register";
	if (cmd === "register") {
		bot.chat(`/register ${config.authmePassword} ${config.authmePassword}`);
		info("auth", "sent /register (password redacted)");
	} else {
		bot.chat(`/login ${config.authmePassword}`);
		info("auth", "sent /login (password redacted)");
	}
	markJoinedBefore();
}

// ---- action dispatch -------------------------------------------------------

// Reflexes call this to fire an async action without blocking the tick.
// Sets busy=true, runs fn, clears busy when done; optional onComplete callback
// receives the action's { ok, detail } result.
// Pull worldDelta fields written by skills (e.g. {choppedAt, logType,
// minedAt, blockType, gotWool, baseAt, shelterAt, depositedTotal,
// plantedAt, harvestedAt, tilledAt}) and turn them into journal lines.
// Any unknown delta is silently skipped — skills can extend the world
// journal without bot.js needing to know each schema.
function recordWorldDeltaToJournal(label, res, snapshot) {
	const wd = res?.worldDelta;
	if (!wd || typeof wd !== "object") return;
	try {
		if (wd.choppedAt) worldJournal.append({ kind: "chopped", name: wd.logType ?? "log", at: wd.choppedAt });
		if (wd.minedAt) worldJournal.append({ kind: "chopped", name: wd.blockType ?? "stone", at: wd.minedAt });
		if (wd.placedAt) worldJournal.append({ kind: "placed", name: wd.placedType ?? "block", at: wd.placedAt });
		if (wd.baseAt) worldJournal.append({ kind: "base", name: "base", at: wd.baseAt });
		if (wd.shelterAt) worldJournal.append({ kind: "shelter", name: "shelter", at: wd.shelterAt });
		if (wd.chestAt) worldJournal.append({ kind: "chest", name: "storage", at: wd.chestAt });
		if (wd.fledTo) worldJournal.append({ kind: "retreat", name: label, at: wd.fledTo });
		if (wd.acquiredFood && snapshot?.position) worldJournal.append({ kind: "food", name: wd.source ?? "food", at: snapshot.position });
		if (wd.plantedAt) worldJournal.append({ kind: "farm", name: "planted", at: wd.plantedAt });
		if (wd.harvestedAt) worldJournal.append({ kind: "farm", name: "harvested", at: wd.harvestedAt });
		if (wd.tilledAt) worldJournal.append({ kind: "farm", name: "tilled", at: wd.tilledAt });
		// failures: blacklisted / no_target — log a dead-end at current pos
		if (res?.code === "no_target" && snapshot?.position) {
			worldJournal.append({
				kind: "dead_end",
				name: label,
				reason: res?.detail ? String(res.detail).slice(0, 80) : "no_target",
				at: snapshot.position,
			});
		}
		if (res?.code === "silent_dig_failure" && snapshot?.position) {
			worldJournal.append({
				kind: "dead_end",
				name: label,
				reason: "silent_dig_failure",
				at: wd?.blacklisted ?? snapshot.position,
			});
		}
	} catch (e) {
		warn("journal", `append from ${label} failed: ${e.message}`);
	}
}

function dispatchAction(fn, label, opts = {}) {
	if (reflexCtx.busy) {
		warn("dispatch", `tried to dispatch ${label} while busy with ${reflexCtx.currentActionLabel}`);
		return;
	}
	reflexCtx.busy = true;
	reflexCtx.currentActionLabel = label;
	// Rolling window of last 8 dispatched skill ids — read by
	// runtime/coach/advisor-trigger.js to detect loops (4+ same in a row)
	reflexCtx.recentSkillIds = reflexCtx.recentSkillIds ?? [];
	reflexCtx.recentSkillIds.push(label);
	if (reflexCtx.recentSkillIds.length > 8) reflexCtx.recentSkillIds.shift();
	// v0.3.0-rc.3 — pre-emption: each dispatch gets a fresh AbortController.
	// awareness/events.js#onPreempt fires controller.abort() when the env
	// shocks (forced move, HP plunge, hostile spawn) the current skill
	// shouldn't run against. runSkill races execute() with the signal and
	// returns code: "preempted" within one microtask.
	const dispatchAbort = new AbortController();
	reflexCtx.currentAbort = dispatchAbort;
	reflexCtx.abortSignal = dispatchAbort.signal;
	const startedAt = Date.now();
	// Capture the situation hash BEFORE the action runs so a failure is
	// attributable to the state at dispatch time, not the state after the
	// (partial) effect.
	const startSnap = lastSnapshot;
	const startSituation = situationHash(startSnap);
	// current-task is a resume anchor — keep it small. Embedding the full
	// perception snapshot blows the file up to ~3 KB per write × every action.
	writeCurrentTask({ label, status: "in_progress", position: startSnap.position });
	info("dispatch", `→ ${label}`);
	Promise.resolve()
		.then(() => fn())
		.then((res) => {
			const ok = !!res?.ok;
			info(
				"dispatch",
				`← ${label} ${ok ? "ok" : "fail"}${res?.detail ? ` (${JSON.stringify(res.detail).slice(0, 80)})` : ""}`,
			);
			writeCurrentTask({ label, status: ok ? "completed" : "failed", detail: res?.detail });
			lastResult = {
				label,
				ok,
				code: res?.code ?? (ok ? "done" : classifyFailure(res?.detail)),
				detail: res?.detail,
				ts: Date.now(),
			};
			skillMetrics.record(label, ok, { code: lastResult.code, durationMs: Date.now() - startedAt });
			scenarioMemory.record({
				skillId: label,
				situation: startSituation,
				code: lastResult.code,
				ok,
				detail: res?.detail,
			});
			recordWorldDeltaToJournal(label, res, startSnap);
			stuckIncident.noteResult(res);
			if (!ok) {
				lastFailureAt = lastResult.ts;
				recordFailure(label, res?.detail);
			} else {
				clearRecentFailures(label);
			}

			if (opts.onComplete) {
				try {
					opts.onComplete(res ?? { ok: false, detail: "no result" });
				} catch (e) {
					warn("dispatch", `onComplete threw for ${label}: ${e.message}`);
				}
			}
		})
		.catch((e) => {
			warn("dispatch", `${label} threw: ${e?.message ?? e}`);
			writeCurrentTask({ label, status: "threw", detail: String(e?.message ?? e) });
			lastResult = {
				label,
				ok: false,
				code: "threw",
				detail: String(e?.message ?? e),
				ts: Date.now(),
			};
			skillMetrics.record(label, false, { code: "threw", durationMs: Date.now() - startedAt });
			scenarioMemory.record({
				skillId: label,
				situation: startSituation,
				code: "threw",
				ok: false,
				detail: String(e?.message ?? e),
			});
			lastFailureAt = lastResult.ts;
			recordFailure(label, String(e?.message ?? e));
		})
		.finally(() => {
			reflexCtx.busy = false;
			reflexCtx.currentActionLabel = null;
			if (reflexCtx.currentAbort === dispatchAbort) {
				reflexCtx.currentAbort = null;
				reflexCtx.abortSignal = null;
			}
		});
}

// ---- failure tracking + proposal detection --------------------------------
//
// A proposal is a request to the LLM to patch the codebase. They cost tokens
// and may produce risky patches that need rolling back. We file them ONLY for
// failures that genuinely look like bugs the reflex layer can't handle on its
// own. Everything else is a feature gap the script should solve via reflex
// chain reordering, cooldowns, or new primitives.

const PROPOSAL_THRESHOLD = 5; // raised from 3 to dampen spam
let lastProposalAt = 0;
const PROPOSAL_COOLDOWN_MS = 30 * 60 * 1000;

// Detail substrings that mean "this is a known feature gap, the bot handles
// it via reflex routing already". Don't file a proposal — the bot will switch
// strategies on its own. If something here is wrong, fix the routing.
const NORMAL_FAILURE_SUBSTRINGS = [
	"no reachable log",
	"no log within",
	"no bed in range",
	"no food in inventory",
	"no target in reach",
	"rate-limited",
	"can't see you nearby",
	"returned false",
	"no result",
];

// Detail substrings that look like a real bug — patch-worthy.
const BUG_FAILURE_SUBSTRINGS = [
	"TypeError",
	"ReferenceError",
	"Cannot read properties",
	"is not a function",
	"is not iterable",
	"is not defined",
	"unknown block",
	"unknown item",
];

function classifyFailure(detail) {
	const s = String(detail ?? "");
	if (BUG_FAILURE_SUBSTRINGS.some((sub) => s.includes(sub))) return "bug";
	if (NORMAL_FAILURE_SUBSTRINGS.some((sub) => s.includes(sub))) return "feature-gap";
	if (s.includes("timed out")) return "timeout";
	return "other";
}

function recordFailure(label, detail) {
	const kind = classifyFailure(detail);
	reflexCtx.recentFailures.push({ ts: Date.now(), label, detail, kind });
	if (reflexCtx.recentFailures.length > 20) reflexCtx.recentFailures.shift();
	maybeFileProposal(label);
}

function clearRecentFailures(label) {
	reflexCtx.recentFailures = reflexCtx.recentFailures.filter((f) => f.label !== label);
}

function maybeFileProposal(label) {
	// Same-label trailing run.
	const trailing = [];
	for (let i = reflexCtx.recentFailures.length - 1; i >= 0; i--) {
		const f = reflexCtx.recentFailures[i];
		if (f.label === label) trailing.push(f);
		else break;
	}
	if (trailing.length < PROPOSAL_THRESHOLD) return;
	if (Date.now() - lastProposalAt < PROPOSAL_COOLDOWN_MS) return;

	// Only file when the run is dominated by bug-class failures (any single
	// bug counts) OR persistent timeouts on the same operation. Feature gaps
	// are skipped — the reflex layer should re-route, not the LLM.
	const anyBug = trailing.some((f) => f.kind === "bug");
	const allTimeout = trailing.every((f) => f.kind === "timeout");
	if (!anyBug && !allTimeout) return;

	lastProposalAt = Date.now();

	const summary = `${label} failed ${trailing.length}× in a row (${anyBug ? "bug" : "persistent timeout"})`;
	const slimSnapshot = lastSnapshot && {
		position: lastSnapshot.position,
		health: lastSnapshot.health,
		food: lastSnapshot.food,
		inventory: lastSnapshot.inventory,
		isDay: lastSnapshot.isDay,
		closestHostile: lastSnapshot.closestHostile,
		dimension: lastSnapshot.dimension,
	};
	const body = [
		`# Repeated failure: ${label}`,
		"",
		`Class: **${anyBug ? "bug" : "persistent timeout"}**.`,
		"",
		"## What happened",
		"",
		`The reflex layer dispatched \`${label}\` ${trailing.length} times in succession without a single success.`,
		"",
		"## Most recent failures",
		"",
		...trailing
			.slice(0, 5)
			.map(
				(f, i) =>
					`${i + 1}. \`${new Date(f.ts).toISOString()}\` [${f.kind}] ${JSON.stringify(f.detail).slice(0, 200)}`,
			),
		"",
		"## Slim snapshot",
		"",
		"```json",
		JSON.stringify(slimSnapshot, null, 2),
		"```",
		"",
		"## Constraints for the patch",
		"",
		"- Touch only files under `runtime/`. Don't touch `extensions/`, `tui/`, or any docs.",
		"- Don't introduce new npm dependencies.",
		"- Don't change `.env` or anything in `state/`.",
		"- Don't push, don't open a PR. Commit on the current branch only.",
		"- Prefer the smallest viable fix. A 3-line guard is better than a 30-line refactor.",
		"- If the failure is genuinely irrecoverable (server-side, not code), document it in a code comment and exit 1.",
	].join("\n");

	const { filename } = writeProposal({ kind: `repeated-fail-${label}`, summary, body });
	warn("proposal", `filed ${filename}: ${summary}`);
	appendDiary(`proposal filed: ${filename} (${summary})`);
}

// Async pre-flight critic — wrapper around writeProposal that asks Pi
// "did the bot actually fail?" first. Runs detached so reflex keeps
// ticking while critic burns 1–60s. If critic.success=true we drop the
// proposal entirely; otherwise the critique is spliced into the body.
async function filePostCritique(incident, channel) {
	const critique = await requestCritique({
		snapshot: lastSnapshot,
		lastResult,
		scenarioTail: scenarioMemory.recentTailFor({ n: 12 }),
		milestone: lastSnapshot?.curriculum?.milestone?.title,
		kind: incident.kind,
	});
	if (critique?.success) {
		info(channel, `critic says already-recovered (${(critique.reasoning || "").slice(0, 100)}) — skipping proposal`);
		return;
	}
	try {
		const body = attachCritique(incident.body, critique);
		const { filename } = writeProposal({
			kind: incident.kind,
			summary: incident.summary,
			body,
			editScope: incident.editScope,
		});
		warn(channel, `filed ${filename}: ${incident.summary}`);
		appendDiary(`${channel}-proposal filed: ${filename} (${incident.summary})`);
	} catch (e) {
		warn(channel, `writeProposal failed: ${e.message}`);
	}
}

// ---- chat (dialog-only via social/) ----------------------------------------
//
// MC chat is dialog-only (Phase 0 of survival-bot PRD). Phase 5 routes
// inbound chat through the social/ layer:
//   1. classifyIntent() decides what the message is.
//   2. generateReply() produces a templated reply (or signals escalate /
//      record-ignored / record-escalation).
//   3. We record every line in the chat memory (with redaction) so future
//      Pi calls can quote recent context without leaking secrets.

let lastChatReplyAt = 0;
const CHAT_REPLY_COOLDOWN_MS = 30_000;
const chatMemory = createChatMemory();

// Rate-limit Pi escalations from chat. The chat path is the cheapest
// way to burn an LLM call accidentally — every addressed banter line
// would otherwise spawn `pi -p`. We cap at MAX_PI_CHAT_PER_HOUR with a
// hard minimum gap of MIN_PI_CHAT_GAP_MS between calls.
const MAX_PI_CHAT_PER_HOUR = 6;
const MIN_PI_CHAT_GAP_MS = 90_000;
const recentPiChatTs = [];
let lastPiChatAt = 0;

function piChatAllowed(now = Date.now()) {
	while (recentPiChatTs.length && now - recentPiChatTs[0] > 3600_000) recentPiChatTs.shift();
	if (recentPiChatTs.length >= MAX_PI_CHAT_PER_HOUR) return false;
	if (now - lastPiChatAt < MIN_PI_CHAT_GAP_MS) return false;
	return true;
}

function escalateChatToPi({ speaker, text, intent }) {
	if (!piChatAllowed()) {
		info("chat", `pi escalation suppressed (rate limit) for ${speaker}`);
		return;
	}
	lastPiChatAt = Date.now();
	recentPiChatTs.push(lastPiChatAt);

	// Compose a slim context — recent chat from this speaker, the bot's
	// own state, and an explicit dialog-only reminder so Pi doesn't try
	// to "act" on a player request via its output. We never write Pi's
	// output to the world; the only side-effect is a single chat line.
	const speakerTail = chatMemory.tail(speaker, 5).map((e) => `${speaker}: ${e.text}`).join("\n");
	const stateLine = JSON.stringify({
		runtimeState: lastSnapshot?.runtimeState,
		activeSkill: lastSnapshot?.activeSkill,
		currentMilestone: lastSnapshot?.currentMilestone,
		noProgressReason: lastSnapshot?.noProgressReason,
		hp: lastSnapshot?.health,
		food: lastSnapshot?.food,
	});
	const prompt = [
		`You are the social cortex for an autonomous Minecraft bot named "${bot?.username}".`,
		`The bot's primary loop ignores chat commands — MC chat is dialog-only.`,
		`Your ONLY output is one short chat line (<= 140 chars) the bot will say to ${speaker}.`,
		`No code, no JSON, no quoting. Just the message. Use the language ${speaker} used.`,
		``,
		`Bot's current state:`,
		stateLine,
		``,
		`Recent chat from ${speaker}:`,
		speakerTail || `(no prior lines)`,
		``,
		`Latest line (intent=${intent}): ${text}`,
	].join("\n");

	let buf = "";
	askPi({
		prompt,
		onChunk: (chunk) => {
			if (chunk?.stream === "stdout") buf += chunk.text;
		},
		onDone: (result) => {
			info("chat", `pi banter reply done code=${result.code} dur=${result.durationMs}ms len=${buf.length}`);
			if (result.code !== 0) return;
			const line = buf.trim().split("\n").find((l) => l.trim()) ?? "";
			if (!line) return;
			// Be defensive — drop the bot's own name prefix Pi sometimes
			// adds, and cap to 200 chars so we never burn the rate-limit
			// with a wall of text.
			const cleaned = line.replace(/^[`"']+|[`"']+$/g, "").slice(0, 200);
			lastChatReplyAt = Date.now();
			botChat(`${speaker}: ${cleaned}`);
		},
	});
}

function isOperator(username) {
	if (!username) return false;
	return config.operators.includes(username.toLowerCase());
}

function handleChat(username, text) {
	if (!bot) return;
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return;
	if (username === bot.username) return; // never reply to ourselves

	chatMemory.append(username, trimmed);
	try { appendChatHistory({ player: username, dir: "in", text: trimmed, snapshot: lastSnapshot }); } catch {}

	const intent = classifyIntent({ text: trimmed, botName: bot.username });

	// Command-like chat → record + one-per-cooldown notice.
	if (intent === INTENTS.COMMAND_LIKE) {
		const op = isOperator(username) ? "operator" : "player";
		info("chat", `ignored command-like chat from ${op} ${username}: ${trimmed.slice(0, 80)}`);
		appendDiary(`ignored command-like chat from ${username}: ${trimmed.slice(0, 120)}`);
		const since = Date.now() - lastChatReplyAt;
		if (since >= CHAT_REPLY_COOLDOWN_MS) {
			lastChatReplyAt = Date.now();
			botChat(`${username}: MC chat is dialog-only — operator uses the TUI to drive me.`);
		}
		return;
	}

	// Unsafe → escalation log + brief notice, no action.
	if (intent === INTENTS.UNSAFE_REQUEST) {
		try {
			writeEscalation({
				from: username,
				request: trimmed.slice(0, 200),
				whyUnsure: "matched unsafe pattern",
				wouldHave: "no action",
			});
		} catch (e) {
			warn("chat", `writeEscalation failed: ${e.message}`);
		}
		const since = Date.now() - lastChatReplyAt;
		if (since >= CHAT_REPLY_COOLDOWN_MS) {
			lastChatReplyAt = Date.now();
			botChat(`${username}: not doing that. logged for operator review.`);
		}
		return;
	}

	// Greetings / status / addressed banter → Pi reply with persona +
	// per-player history. The old template path stays as a fast
	// fallback when Pi is unavailable or times out.
	const since = Date.now() - lastChatReplyAt;
	if (since < CHAT_REPLY_COOLDOWN_MS) return;
	const diaryTail = (() => {
		try { return readDiaryTail(1); } catch { return null; }
	})();

	(async () => {
		try {
			const pi = await piReply({ player: username, text: trimmed, snapshot: lastSnapshot, diaryTail });
			if (pi) {
				lastChatReplyAt = Date.now();
				botChat(pi);
				try { appendChatHistory({ player: username, dir: "out", text: pi, snapshot: lastSnapshot }); } catch {}
				return;
			}
		} catch (e) {
			warn("chat", `piReply threw: ${e.message}`);
		}
		// Fallback: templated reply so the bot still says something.
		const result = generateReply({ intent, speaker: username, snapshot: lastSnapshot, diaryTail });
		if (result?.send) {
			lastChatReplyAt = Date.now();
			botChat(result.send);
			try { appendChatHistory({ player: username, dir: "out", text: result.send, snapshot: lastSnapshot }); } catch {}
		}
	})();
}

// ---- connect ---------------------------------------------------------------

function connect() {
	if (bot) return;
	info("mc", `connecting as ${config.username} → ${config.host}:${config.port} (v${config.version})`);
	bot = mineflayer.createBot({
		host: config.host,
		port: config.port,
		username: config.username,
		auth: config.authMode === "microsoft" ? "microsoft" : "offline",
		version: config.mineflayerVersion,
		hideErrors: false,
	});
	reflexCtx.bot = bot;

	bot.once("spawn", () => {
		botSpawnedAt = Date.now();
		info("mc", `spawned at ${JSON.stringify(bot.entity.position)}`);
		appendDiary(`spawned at ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}`);
		ipc?.broadcast(EVENT_TYPES.STATUS, buildSnapshot(bot));
		maybeStartViewer(bot).catch((e) => warn("viewer", `start threw: ${e?.message ?? e}`));
		// Pathfinder stuck-watchdog: replan when an obstacle appears mid-path
		// (mineflayer-pathfinder doesn't recompute on world changes).
		try {
			pathWatchdog?.stop();
			pathWatchdog = createPathfinderWatchdog(bot);
			info("pathfinder", "stuck-replan watchdog armed");
		} catch (e) { warn("pathfinder", `watchdog start failed: ${e?.message ?? e}`); }
		// MotionService (L1): structured gotoSafe() with wall-clock timeout +
		// progress watchdog + noPath/timeout listener. Skills opt in for a
		// {ok|stuck|timeout|nopath} result instead of a silent hang.
		try {
			motionService = createMotionService(bot);
			reflexCtx.motion = motionService;
			info("motion", "MotionService armed");
		} catch (e) { warn("motion", `MotionService start failed: ${e?.message ?? e}`); }
		// v0.2.0 — self-learning coach + persona narration. Both are
		// import-safe; they just attach listeners and (for coach) a periodic
		// Pi-drain timer. See docs/v0.2.0-self-learning.md.
		// v0.3.0 — coach/reflect run on TimeWeb (fast LLM). Pi CLI is no
		// longer wired into background loops; it remains available for
		// manual operator commands only.
		try { attachCoach(bot, { stateDir }); } catch (e) { warn("coach", `attach: ${e?.message ?? e}`); }
		try { attachReflect({ bot, stateDir, getSnapshot: () => lastSnapshot }); } catch (e) { warn("reflect", `attach: ${e?.message ?? e}`); }
		try { attachTuner(); } catch (e) { warn("tuner", `attach: ${e?.message ?? e}`); }
		try { attachChatter(bot, { getSnapshot: () => lastSnapshot }); } catch (e) { warn("persona", `attach: ${e?.message ?? e}`); }
		// v0.3.0-rc.3 — awareness layer: listens to bot.on('move'/'health'/
		// 'entitySpawn'/'blockUpdate') and aborts the current dispatch via
		// reflexCtx.currentAbort when something disrupts the in-flight skill.
		try {
			awarenessState = attachAwareness(bot, {
				onPreempt: ({ reason, payload }) => {
					const abort = reflexCtx.currentAbort;
					if (abort && !abort.signal.aborted) {
						info("preempt", `aborting ${reflexCtx.currentActionLabel ?? "?"} due to ${reason}`);
						abort.abort();
					}
					reflexCtx.lastPreempt = { reason, payload, at: Date.now() };
				},
			});
			reflexCtx.awareness = awarenessState;
		} catch (e) { warn("awareness", `attach: ${e?.message ?? e}`); }
	});

	bot.on("messagestr", (text) => {
		ipc?.broadcast(EVENT_TYPES.CHAT, { from: "server", text, kind: "system" });
		maybeHandleAuthPrompt(text);
	});

	bot.on("chat", (username, message) => {
		if (username === bot.username) return;
		ipc?.broadcast(EVENT_TYPES.CHAT, { from: username, text: message, kind: "player" });
		try {
			handleChat(username, message);
		} catch (e) {
			warn("chat", `chat handler threw: ${e.message}`);
		}
	});

	bot.on("death", () => {
		const pos = bot.entity?.position;
		warn("mc", `died at ${JSON.stringify(pos)}`);
		appendDiary(`died at ${pos?.x.toFixed(0)},${pos?.y.toFixed(0)},${pos?.z.toFixed(0)}`);
		ipc?.broadcast(EVENT_TYPES.DEATH, { reason: "unknown", position: pos });
		clearCurrentTask();
	});

	bot.on("kicked", (reason) => {
		warn("mc", `kicked: ${reason}`);
	});

	bot.on("error", (err) => {
		error("mc", `bot error: ${err?.message ?? err}`);
	});

	bot.on("end", (reason) => {
		warn("mc", `connection ended: ${reason}`);
		bot = null;
		reflexCtx.bot = null;
		motionService = null;
		reflexCtx.motion = null;
		lastSnapshot = { connected: false };
		if (!shuttingDown) scheduleReconnect();
	});
}

function scheduleReconnect() {
	if (reconnectTimer || shuttingDown) return;
	const delay = 5000;
	info("mc", `reconnecting in ${delay}ms`);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, delay);
}

// ---- escalation ------------------------------------------------------------

function maybeAutoEscalate() {
	if (reflexCtx.busy) return;
	if (consecutiveNoops < ESCALATE_AFTER_NOOPS) return;
	const since = Date.now() - lastEscalationAt;
	if (since < ESCALATION_COOLDOWN_MS) return;
	lastEscalationAt = Date.now();
	consecutiveNoops = 0;

	const promptCtx = JSON.stringify(lastSnapshot, null, 2);
	const prompt = [
		`You are the escalation cortex for an autonomous Minecraft bot. The bot's`,
		`script-driven reflex loop has produced no useful action for ${ESCALATE_AFTER_NOOPS} consecutive ticks`,
		`(~${Math.round((ESCALATE_AFTER_NOOPS * config.tickIntervalMs) / 1000)}s). The reflex chain is:`,
		`  defend > eat > sleep > tech-tree > autonomous > idle`,
		`Snapshot:`,
		"```json",
		promptCtx,
		"```",
		`Decide ONE next thing the bot should attempt. Output as plain text — what it should do and why, in 3 lines max.`,
		`If "do nothing" is the right answer, say so.`,
		`Do NOT propose code changes. Do NOT propose anything beyond what mineflayer + the existing actions (attack, flee, eat, sleep, goTo) can do.`,
	].join("\n");

	info("escalation", `firing askPi after ${ESCALATE_AFTER_NOOPS} noops`);
	askPi({
		prompt,
		onChunk: (chunk) => ipc?.broadcast(EVENT_TYPES.ASK_PI_CHUNK, chunk),
		onDone: (result) => {
			info("escalation", `pi done code=${result.code} dur=${result.durationMs}ms`);
			ipc?.broadcast(EVENT_TYPES.ASK_PI_DONE, result);
		},
	});
}

// ---- tick ------------------------------------------------------------------

function failuresByCode() {
	const counts = {};
	for (const f of reflexCtx.recentFailures) {
		const k = f.kind || "other";
		counts[k] = (counts[k] ?? 0) + 1;
	}
	return counts;
}

function refreshMilestoneCache(now) {
	if (now - lastPlanReadAt < MILESTONE_CACHE_MS) return;
	lastPlanReadAt = now;
	try {
		cachedMilestone = readNextMilestone();
		cachedPlanExists = planExists();
	} catch (e) {
		warn("planner", `milestone read failed: ${e.message}`);
	}
}

function tick() {
	if (shuttingDown) return;
	const now = Date.now();
	if (bot && bot.entity) {
		// L1: record an inventory snapshot every tick so skills can verify
		// pickups by diff (ledger.gainedSince/acquired) rather than trusting
		// the unreliable playerCollect event.
		try { inventoryLedger.update(bot, now); } catch {}
		lastSnapshot = buildSnapshot(bot);
		lastSnapshot.pendingProposals = listProposals().length;
		lastSnapshot.lastReflex = reflexCtx.lastReflex ?? null;
		lastSnapshot.busy = reflexCtx.busy
			? { label: reflexCtx.currentActionLabel ?? "?" }
			: null;
		// Curriculum + locations MUST be computed BEFORE runTick so the
		// curriculum reflex sees the suggested skill in snapshot.curriculum.
		// (Pre-2026-05-26 they were computed after — every tick fell through
		// to the wander fallback because plan.skillId was undefined.)
		try {
			lastSnapshot.locations = listLocations();
		} catch {
			lastSnapshot.locations = {};
		}
		const curriculumEarly = nextCurriculumMilestone(lastSnapshot);
		lastSnapshot.curriculum = curriculumEarly;
		// Time since spawn — used by storyline orient_self to fall through
		// when bot is in a barren biome that never produces "saw blocks".
		lastSnapshot._sessionMs = botSpawnedAt ? Date.now() - botSpawnedAt : 0;
		// Storyline current step — surfaced in snapshot so chatter and
		// other observers can react to step transitions without
		// re-importing the picker.
		try { lastSnapshot.storyStep = pickCurrentStep(lastSnapshot); } catch {}
		// L3 Settlement Contract: evaluate milestone invariants against the
		// world and surface the unified progression goal + suggested skill.
		// Precomputed here (like curriculum/storyStep) so reflex.js consumes
		// snapshot.contract and the TUI/score read it without re-walking.
		try {
			lastSnapshot.contract = goalManager.next(lastSnapshot, { ledger: inventoryLedger });
			lastSnapshot.villageScore = computeVillageScore(lastSnapshot, {
				contract: lastSnapshot.contract,
				uptimeMs: botSpawnedAt ? Date.now() - botSpawnedAt : 0,
				metrics: skillMetrics.snapshot(),
			});
		} catch (e) { warn("contract", `eval failed: ${e?.message ?? e}`); }
		reflexCtx.snapshot = lastSnapshot;
		if (!reflexPaused) {
			const result = runTick(reflexCtx);
			if (!result || result.action === "noop") {
				consecutiveNoops++;
				maybeAutoEscalate();
			} else if (result.action === "skipped") {
				// busy — neither productive nor stuck; don't increment noops
			} else {
				consecutiveNoops = 0;
			}
		}

		// Observability: compute runtime state + no-progress reason and
		// stamp them on the snapshot so the TUI / future surfaces can show
		// one concrete answer to "why is the bot idle?".
		refreshMilestoneCache(now);
		const plannerInFlight = isPlannerBusy();
		const runtimeState = computeState({
			snapshot: lastSnapshot,
			ctx: reflexCtx,
			plannerInFlight,
			lastChatReplyAt,
			lastFailureAt,
			now,
		});
		const noProgressReason = noProgress.detect({
			snapshot: lastSnapshot,
			ctx: reflexCtx,
			planExists: cachedPlanExists,
			now,
		});

		lastSnapshot.runtimeState = runtimeState;
		lastSnapshot.activeSkill = reflexCtx.busy
			? reflexCtx.currentActionLabel
			: reflexCtx.lastReflex?.label ?? null;
		// Curriculum + locations were already computed before runTick (above).
		// Re-stamp the title here so observability fields stay together.
		const curriculum = lastSnapshot.curriculum;
		lastSnapshot.currentMilestone = curriculum?.milestone?.title ?? cachedMilestone;
		lastSnapshot.lastResult = lastResult;
		lastSnapshot.noProgressReason = noProgressReason;
		lastSnapshot.failuresByCode = failuresByCode();
		lastSnapshot.skillMetrics = skillMetrics.snapshot();
		lastSnapshot.lastEscalation = lastEscalationAt
			? { ts: lastEscalationAt, ageMs: now - lastEscalationAt }
			: null;
		lastSnapshot.reflexPaused = reflexPaused;

		// Stuck-incident detector: file a structured proposal when the same
		// no-progress reason persists past the threshold. Kept separate from
		// the existing bug-class failure tracker — they target different
		// classes of breakage. The detector enforces its own cooldown so we
		// don't spam the proposals dir.
		const stuck = stuckIncident.check({
			snapshot: lastSnapshot,
			lastResult,
			metrics: lastSnapshot.skillMetrics,
			journalSummary: worldJournal.summary(),
			scenarioTail: scenarioMemory.recentTailFor({ n: 12 }),
			now,
		});
		if (stuck?.fire) {
			void filePostCritique(stuck, "stuck");
		}

		// Second fast-track trigger: explicit wedged loop (escape-pit ran N
		// times in a row without freeing the bot). Auto-improve picks this
		// up like any other proposal — Pi writes a new escape strategy.
		const wedged = stuckIncident.checkWedged({
			snapshot: lastSnapshot,
			lastResult,
			metrics: lastSnapshot.skillMetrics,
			journalSummary: worldJournal.summary(),
			scenarioTail: scenarioMemory.recentTailFor({ n: 12 }),
			now,
		});
		if (wedged?.fire) {
			void filePostCritique(wedged, "wedged");
		}

		// QW5 — anti-loop: a skill that failed ≥3× in 5 min is blacklisted by
		// the detector; here we turn each fired loop into an improvement_request
		// so the operator/Codex gets a concrete ticket instead of silent thrash.
		for (const loop of antiLoop.drainFired()) {
			try {
				writeProposal({
					kind: `anti-loop-${loop.skillId}`,
					summary: `${loop.skillId} looped ${loop.count}× in 5min (last code=${loop.code ?? "?"})`,
					body: [
						`# Anti-loop: ${loop.skillId}`,
						``,
						`The same skill failed ${loop.count} times within 5 minutes with no success`,
						`in between, so it has been blacklisted until ${new Date(loop.until).toISOString()}.`,
						``,
						`- skill: ${loop.skillId}`,
						loop.targetKey ? `- target: ${loop.targetKey}` : `- target: (none)`,
						`- last failure code: ${loop.code ?? "?"}`,
						`- runtime state: ${lastSnapshot.runtimeState ?? "?"}`,
						`- no-progress reason: ${lastSnapshot.noProgressReason ?? "?"}`,
						`- position: ${JSON.stringify(lastSnapshot.position ?? null)}`,
						`- milestone: ${lastSnapshot.contract?.milestone?.id ?? lastSnapshot.currentMilestone ?? "?"}`,
						``,
						`## Suggested fix`,
						`Either the skill's preconditions are too loose (it keeps being chosen`,
						`when it cannot succeed here) or it needs a real recovery branch. Inspect`,
						`runtime/skills/${loop.skillId.split(".").pop()}*.js and the scheduler path.`,
					].join("\n"),
					editScope: ["runtime/skills/", "runtime/reflex.js", "runtime/modes.js"],
				});
			} catch (e) {
				warn("anti-loop", `writeProposal failed: ${e?.message ?? e}`);
			}
		}

		ipc?.broadcast(EVENT_TYPES.STATUS, lastSnapshot);
	} else {
		lastSnapshot = { connected: false };
		ipc?.broadcast(EVENT_TYPES.STATUS, lastSnapshot);
	}
}

function startTickLoop() {
	if (tickTimer) clearInterval(tickTimer);
	tickTimer = setInterval(tick, config.tickIntervalMs);
	startPerfBufferReaper();
}

// mineflayer + mineflayer-pathfinder emit performance.mark/measure
// entries that accumulate in the global perf_hooks buffer with no
// upper bound. Over a multi-hour run this grew past 1,000,000 entries
// ("MaxPerformanceEntryBufferExceededWarning") and is a prime suspect
// for the overnight OOM. We don't consume those entries, so clear the
// buffer on a slow interval.
let perfReaperTimer = null;
function startPerfBufferReaper() {
	if (perfReaperTimer) return;
	perfReaperTimer = setInterval(() => {
		try {
			performance.clearMeasures?.();
			performance.clearMarks?.();
		} catch {}
	}, 60_000);
	perfReaperTimer.unref?.();
}

// ---- IPC commands ----------------------------------------------------------

function handleCommand(msg, send) {
	switch (msg.type) {
		case COMMAND_TYPES.PAUSE:
			reflexPaused = true;
			info("ipc", "reflex paused by client");
			break;
		case COMMAND_TYPES.RESUME:
			reflexPaused = false;
			info("ipc", "reflex resumed by client");
			break;
		case COMMAND_TYPES.STOP:
			info("ipc", "stop requested by client");
			gracefulExit(0);
			break;
		case COMMAND_TYPES.CHAT: {
			const text = (msg.payload?.text || "").trim();
			if (!text || !bot) return;
			if (!chatRateAllowed()) {
				send(EVENT_TYPES.ERROR, { source: "chat", text: "rate-limited" });
				return;
			}
			bot.chat(text);
			break;
		}
		case COMMAND_TYPES.ASK_PI: {
			const prompt = msg.payload?.prompt;
			if (!prompt) return;
			askPi({
				prompt,
				onChunk: (chunk) => ipc?.broadcast(EVENT_TYPES.ASK_PI_CHUNK, chunk),
				onDone: (result) => ipc?.broadcast(EVENT_TYPES.ASK_PI_DONE, result),
			});
			break;
		}
		case COMMAND_TYPES.SNAPSHOT:
			send(EVENT_TYPES.STATUS, lastSnapshot);
			break;
		case COMMAND_TYPES.PROPOSAL_LATEST: {
			const all = listProposals();
			if (all.length === 0) {
				send(EVENT_TYPES.PROPOSAL, { filename: null, body: null, total: 0 });
				return;
			}
			const filename = all[all.length - 1];
			send(EVENT_TYPES.PROPOSAL, {
				filename,
				body: readProposal(filename),
				total: all.length,
			});
			break;
		}
		case COMMAND_TYPES.PROPOSAL_APPROVE: {
			const filename = msg.payload?.filename;
			if (!filename) return;
			try {
				const dst = approveProposal(filename);
				info("proposal", `approved ${filename} → ${dst}`);
				appendDiary(`proposal approved: ${filename}`);
			} catch (e) {
				send(EVENT_TYPES.ERROR, { source: "proposal", text: e.message });
			}
			break;
		}
		case COMMAND_TYPES.RUN_SKILL: {
			const skillId = msg.payload?.skillId;
			const args = msg.payload?.args ?? {};
			if (!skillId) {
				send(EVENT_TYPES.ERROR, { source: "run-skill", text: "missing skillId" });
				return;
			}
			info("ipc", `run-skill: queued ${skillId} args=${JSON.stringify(args)} (will wait for current action)`);
			// Pause the reflex loop while we wait so it doesn't immediately
			// schedule another action and starve our request.
			const wasPaused = reflexPaused;
			reflexPaused = true;
			const deadline = Date.now() + 120_000;
			const tryDispatch = () => {
				if (!reflexCtx.busy) {
					info("ipc", `run-skill: dispatching ${skillId}`);
					dispatchAction(() => runSkill(skillId, reflexCtx, args), `ipc:${skillId}`, {
						onComplete: (res) => {
							reflexPaused = wasPaused;
							send(EVENT_TYPES.LOG, {
								ts: new Date().toISOString(),
								level: "info",
								source: "run-skill",
								text: `${skillId} → ${res.code ?? (res.ok ? "ok" : "fail")}`,
								details: res,
							});
						},
					});
					return;
				}
				if (Date.now() > deadline) {
					reflexPaused = wasPaused;
					send(EVENT_TYPES.ERROR, { source: "run-skill", text: `still busy after 2 min with ${reflexCtx.currentActionLabel}` });
					return;
				}
				setTimeout(tryDispatch, 500);
			};
			tryDispatch();
			break;
		}
		case COMMAND_TYPES.CONV_SAY: {
			const { topic: topic_, text, intent, position } = msg.payload ?? {};
			if (!topic_ || !text) { send(EVENT_TYPES.ERROR, { source: "conv", text: "topic and text required" }); return; }
			try {
				const h = openConversation(topic_, { speaker: config.username });
				const turn = h.append({ text, intent, position: position ?? lastSnapshot?.position });
				send(EVENT_TYPES.LOG, { ts: new Date().toISOString(), level: "info", source: "conv", text: `say to ${topic_}`, details: turn });
			} catch (e) { send(EVENT_TYPES.ERROR, { source: "conv", text: e.message }); }
			break;
		}
		case COMMAND_TYPES.CONV_RECENT: {
			const { topic: topic_, n } = msg.payload ?? {};
			if (!topic_) { send(EVENT_TYPES.ERROR, { source: "conv", text: "topic required" }); return; }
			try {
				const turns = peekConversation(topic_, n ?? 10);
				send(EVENT_TYPES.LOG, { ts: new Date().toISOString(), level: "info", source: "conv", text: `recent ${topic_}`, details: { topic: topic_, turns } });
			} catch (e) { send(EVENT_TYPES.ERROR, { source: "conv", text: e.message }); }
			break;
		}
		case COMMAND_TYPES.CONV_LIST: {
			try {
				const topics = listConversations();
				send(EVENT_TYPES.LOG, { ts: new Date().toISOString(), level: "info", source: "conv", text: "list", details: { topics } });
			} catch (e) { send(EVENT_TYPES.ERROR, { source: "conv", text: e.message }); }
			break;
		}
		case COMMAND_TYPES.SCREENSHOT: {
			const { reason, frames } = msg.payload ?? {};
			(async () => {
				if (!bot) { send(EVENT_TYPES.ERROR, { source: "viewer", text: "bot not connected" }); return; }
				const res = await takeScreenshot(bot, { reason: reason ?? "ipc", frames: frames ?? 1 });
				send(EVENT_TYPES.LOG, { ts: new Date().toISOString(), level: "info", source: "viewer", text: res.ok ? `screenshot ok` : `screenshot fail`, details: res });
			})();
			break;
		}
		case COMMAND_TYPES.FORCE_INCIDENT: {
			const { kind, reason } = msg.payload ?? {};
			(async () => {
				const fakeIncident = {
					kind: kind ?? "force-demo",
					summary: `forced incident: ${reason ?? "operator demo"}`,
					body: stuckIncident._renderFake
						? stuckIncident._renderFake({ snapshot: lastSnapshot, lastResult, reason: reason ?? "operator demo" })
						: `# Forced incident\n\nOperator triggered via cmd:force-incident.\n\n## Snapshot\n\n\`\`\`json\n${JSON.stringify(lastSnapshot ?? {}, null, 2).slice(0, 2000)}\n\`\`\`\n\n## Last action\n\n${lastResult ? `\`${lastResult.label}\` → ${lastResult.code}` : "_(none)_"}\n\n## Suggested fix\n\nReview the snapshot and propose a productive next skill, or document why no productive action is possible from this state.\n\n## Edit scope\n\n- runtime/skills/\n- runtime/reflex.js\n`,
					editScope: ["runtime/skills/", "runtime/reflex.js"],
				};
				send(EVENT_TYPES.LOG, { ts: new Date().toISOString(), level: "info", source: "force", text: `dispatching critic for ${fakeIncident.kind}` });
				await filePostCritique(fakeIncident, "force");
				send(EVENT_TYPES.LOG, { ts: new Date().toISOString(), level: "info", source: "force", text: `force-incident done — check state/proposals/` });
			})();
			break;
		}
		default:
			warn("ipc", `unknown command type: ${msg.type}`);
	}
}

// ---- shutdown --------------------------------------------------------------

function gracefulExit(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	info("runtime", "shutting down");
	if (tickTimer) clearInterval(tickTimer);
	if (reconnectTimer) clearTimeout(reconnectTimer);
	try { pathWatchdog?.stop(); } catch {}
	pathWatchdog = null;
	try {
		bot?.quit("shutdown");
	} catch {}
	ipc?.close();
	setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => gracefulExit(0));
process.on("SIGTERM", () => gracefulExit(0));

info("runtime", `pepa runtime starting; cfg=${JSON.stringify(redactedConfig())}`);

// Resume info: surface stale state across restarts. We don't auto-resume any
// action — but we tell the operator if the bot died mid-task last time, and
// the count of pending proposals.
const lastTask = readCurrentTask();
if (lastTask && lastTask.label) {
	info("resume", `previous task: ${lastTask.label} (${lastTask.status ?? "?"}, ${lastTask.ts ?? "?"})`);
	if (lastTask.status === "in_progress") {
		warn("resume", `last shutdown happened mid-action — operator should review state/<host>/current-task.json`);
	}
}
const pendingProposals = listProposals();
if (pendingProposals.length > 0) {
	warn("resume", `${pendingProposals.length} pending proposal(s) — see state/<host>/proposals/`);
}

ipc = createIpcServer({
	getStatusSnapshot: () => ({
		...lastSnapshot,
		pendingProposals: listProposals().length,
	}),
	onCommand: handleCommand,
});
connect();
startTickLoop();
startAutoImprover();
startPlanner(() => lastSnapshot);
