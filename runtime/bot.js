// Long-running Mineflayer process. Owns:
//   - the MC TCP connection + reconnect policy
//   - the reflex tick loop (no LLM in hot path)
//   - the IPC server for TUI clients
//   - on-demand Pi-headless escalation (manual or automatic)
//   - simple operator-chat commands from OPERATOR_USERNAMES
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

// Reflex context — passed into reflex.js every tick. Mutable across ticks.
const reflexCtx = {
	bot: null,
	snapshot: lastSnapshot,
	busy: false,
	currentActionLabel: null,
	operatorGoal: null,
	idleCounter: 0,
	lastEatAt: 0,
	lastSleepAttemptAt: 0,
	dispatch: dispatchAction,
	clearOperatorGoal: () => {
		reflexCtx.operatorGoal = null;
	},
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
	info("dispatch", `→ ${label}`);
	Promise.resolve()
		.then(() => fn())
		.then((res) => {
			info("dispatch", `← ${label} ${res?.ok ? "ok" : "fail"}${res?.detail ? ` (${JSON.stringify(res.detail).slice(0, 80)})` : ""}`);
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
		})
		.finally(() => {
			reflexCtx.busy = false;
			reflexCtx.currentActionLabel = null;
		});
}

// ---- operator chat commands ------------------------------------------------

function isOperator(username) {
	if (!username) return false;
	return config.operators.includes(username.toLowerCase());
}

function handleOperatorChat(username, text) {
	// Two address formats accepted: prefix "<botname>," or "<botname>:" (case-insensitive),
	// or full chat starting with the bot's own name. We're permissive here.
	const lower = text.trim().toLowerCase();
	const botname = bot.username.toLowerCase();
	const prefixed = lower.startsWith(botname + " ") || lower.startsWith(botname + ",") || lower.startsWith(botname + ":");
	const stripped = prefixed ? text.trim().slice(botname.length).replace(/^[,:\s]+/, "") : text.trim();
	const cmd = stripped.toLowerCase();

	// Unaddressed chat is fine — just don't treat it as a command.
	if (!prefixed) return;

	info("operator", `${username} → "${cmd}"`);

	if (cmd === "status" || cmd === "how are you?") {
		const s = lastSnapshot;
		botChat(
			`hp=${s.health}/20 food=${s.food}/20 pos=${s.position?.x},${s.position?.y},${s.position?.z}${
				s.hostileCount ? ` hostiles=${s.hostileCount}` : ""
			}${reflexCtx.busy ? ` busy=${reflexCtx.currentActionLabel}` : ""}`,
		);
		return;
	}
	if (cmd === "pause") {
		reflexPaused = true;
		botChat(`reflex paused, awaiting your call.`);
		return;
	}
	if (cmd === "resume") {
		reflexPaused = false;
		botChat(`reflex resumed.`);
		return;
	}
	if (cmd === "stop") {
		botChat(`bye.`);
		setTimeout(() => gracefulExit(0), 500);
		return;
	}
	if (cmd === "come" || cmd === "come here") {
		const op = Object.values(bot.entities).find((e) => e.username === username);
		if (!op) {
			botChat(`${username}: can't see you nearby.`);
			return;
		}
		reflexCtx.operatorGoal = {
			kind: "come",
			from: username,
			x: Math.round(op.position.x),
			y: Math.round(op.position.y),
			z: Math.round(op.position.z),
		};
		botChat(`on my way to ${reflexCtx.operatorGoal.x},${reflexCtx.operatorGoal.y},${reflexCtx.operatorGoal.z}`);
		return;
	}

	botChat(`${username}: didn't recognize "${cmd}". I know: status, come, pause, resume, stop.`);
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
		version: config.version,
		hideErrors: false,
	});
	reflexCtx.bot = bot;

	bot.once("spawn", () => {
		info("mc", `spawned at ${JSON.stringify(bot.entity.position)}`);
		ipc?.broadcast(EVENT_TYPES.STATUS, buildSnapshot(bot));
	});

	bot.on("messagestr", (text) => {
		ipc?.broadcast(EVENT_TYPES.CHAT, { from: "server", text, kind: "system" });
		maybeHandleAuthPrompt(text);
	});

	bot.on("chat", (username, message) => {
		if (username === bot.username) return;
		ipc?.broadcast(EVENT_TYPES.CHAT, { from: username, text: message, kind: "player" });
		if (isOperator(username)) {
			try {
				handleOperatorChat(username, message);
			} catch (e) {
				warn("operator", `handler threw: ${e.message}`);
			}
		}
	});

	bot.on("death", () => {
		const pos = bot.entity?.position;
		warn("mc", `died at ${JSON.stringify(pos)}`);
		ipc?.broadcast(EVENT_TYPES.DEATH, { reason: "unknown", position: pos });
		// On death, drop any operator goal — they need to ask again.
		reflexCtx.operatorGoal = null;
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
		`  operator-goal > defend > eat > sleep > idle`,
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

function tick() {
	if (shuttingDown) return;
	if (bot && bot.entity) {
		lastSnapshot = buildSnapshot(bot);
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
ipc = createIpcServer({
	getStatusSnapshot: () => lastSnapshot,
	onCommand: handleCommand,
});
connect();
startTickLoop();
