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
import { nextMilestone as nextCurriculumMilestone } from "./curriculum.js";
import { classifyIntent, INTENTS } from "./social/intent.js";
import { generateReply } from "./social/reply.js";
import { createChatMemory } from "./social/memory.js";
import { createStuckIncidentDetector } from "./stuck-incident.js";
import { createSkillMetrics } from "./skill-metrics.js";

fs.mkdirSync(stateDir, { recursive: true });
const JOINED_FLAG = path.join(stateDir, "joined-before.flag");

// Auto-escalation tunables. With tick=3s, 20 noops ≈ 1 minute idle before we
// even consider asking Pi. Cooldown prevents spamming the LLM when the bot
// is permanently stuck on the same situation.
const ESCALATE_AFTER_NOOPS = 20;
const ESCALATION_COOLDOWN_MS = 10 * 60 * 1000;

let bot = null;
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
const stuckIncident = createStuckIncidentDetector();
const skillMetrics = createSkillMetrics();
let lastResult = null; // { label, ok, code, detail, ts }
let lastFailureAt = 0;
let lastPlanReadAt = 0;
let cachedMilestone = null;
let cachedPlanExists = false;
const MILESTONE_CACHE_MS = 30_000;

// Reflex context — passed into reflex.js every tick. Mutable across ticks.
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
function dispatchAction(fn, label, opts = {}) {
	if (reflexCtx.busy) {
		warn("dispatch", `tried to dispatch ${label} while busy with ${reflexCtx.currentActionLabel}`);
		return;
	}
	reflexCtx.busy = true;
	reflexCtx.currentActionLabel = label;
	// current-task is a resume anchor — keep it small. Embedding the full
	// perception snapshot blows the file up to ~3 KB per write × every action.
	writeCurrentTask({ label, status: "in_progress", position: lastSnapshot.position });
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
			skillMetrics.record(label, ok);
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
			skillMetrics.record(label, false);
			lastFailureAt = lastResult.ts;
			recordFailure(label, String(e?.message ?? e));
		})
		.finally(() => {
			reflexCtx.busy = false;
			reflexCtx.currentActionLabel = null;
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

function isOperator(username) {
	if (!username) return false;
	return config.operators.includes(username.toLowerCase());
}

function handleChat(username, text) {
	if (!bot) return;
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return;

	chatMemory.append(username, trimmed);

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

	// Greetings / status / addressed banter → templated reply, rate-limited.
	const since = Date.now() - lastChatReplyAt;
	if (since < CHAT_REPLY_COOLDOWN_MS) return;
	const diaryTail = (() => {
		try { return readDiaryTail(1); } catch { return null; }
	})();
	const result = generateReply({ intent, speaker: username, snapshot: lastSnapshot, diaryTail });
	if (result?.send) {
		lastChatReplyAt = Date.now();
		botChat(result.send);
		return;
	}
	// Templates didn't fit and the bot was addressed (ADDRESSED_BANTER) —
	// escalation to Pi is allowed but not done from here; future work will
	// route through a rate-limited askPi with prompt-cached context.
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
		info("mc", `spawned at ${JSON.stringify(bot.entity.position)}`);
		appendDiary(`spawned at ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}`);
		ipc?.broadcast(EVENT_TYPES.STATUS, buildSnapshot(bot));
		maybeStartViewer(bot).catch((e) => warn("viewer", `start threw: ${e?.message ?? e}`));
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
		lastSnapshot = buildSnapshot(bot);
		lastSnapshot.pendingProposals = listProposals().length;
		lastSnapshot.lastReflex = reflexCtx.lastReflex ?? null;
		lastSnapshot.busy = reflexCtx.busy
			? { label: reflexCtx.currentActionLabel ?? "?" }
			: null;
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
		// Two sources of "next milestone":
		//   - planner.md (LLM-written, free-form, advisory)
		//   - curriculum.js (deterministic early-game progression)
		// The TUI prefers the curriculum's structured milestone (it has a
		// suggested skill); falls back to the planner line for late-game.
		const curriculum = nextCurriculumMilestone(lastSnapshot);
		lastSnapshot.curriculum = curriculum;
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
			now,
		});
		if (stuck?.fire) {
			try {
				const { filename } = writeProposal({
					kind: stuck.kind,
					summary: stuck.summary,
					body: stuck.body,
					editScope: stuck.editScope,
				});
				warn("stuck", `filed ${filename}: ${stuck.summary}`);
				appendDiary(`stuck-proposal filed: ${filename} (${stuck.summary})`);
			} catch (e) {
				warn("stuck", `writeProposal failed: ${e.message}`);
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
