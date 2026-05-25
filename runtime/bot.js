// Long-running Mineflayer process. Owns:
//   - the MC TCP connection + reconnect policy
//   - the reflex tick loop (no LLM in hot path)
//   - the IPC server for TUI clients
//   - on-demand Pi-headless escalation
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

let bot = null;
let reflexPaused = false;
let tickTimer = null;
let reconnectTimer = null;
let shuttingDown = false;
let lastSnapshot = { connected: false };

const reflexCtx = { snapshot: lastSnapshot, idleCounter: 0 };

let chatTimestamps = [];
const CHAT_WINDOW_MS = 60_000;

let ipc;

function chatRateAllowed() {
	const now = Date.now();
	chatTimestamps = chatTimestamps.filter((t) => now - t < CHAT_WINDOW_MS);
	if (chatTimestamps.length >= config.chatRateLimitPerMin) return false;
	chatTimestamps.push(now);
	return true;
}

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

	bot.once("spawn", () => {
		info("mc", `spawned at ${JSON.stringify(bot.entity.position)}`);
		ipc?.broadcast(EVENT_TYPES.STATUS, buildSnapshot(bot));
	});

	bot.on("messagestr", (text, _position, _jsonMsg) => {
		ipc?.broadcast(EVENT_TYPES.CHAT, { from: "server", text, kind: "system" });
		maybeHandleAuthPrompt(text);
	});

	bot.on("chat", (username, message) => {
		if (username === bot.username) return;
		ipc?.broadcast(EVENT_TYPES.CHAT, { from: username, text: message, kind: "player" });
	});

	bot.on("death", () => {
		const pos = bot.entity?.position;
		warn("mc", `died at ${JSON.stringify(pos)}`);
		ipc?.broadcast(EVENT_TYPES.DEATH, { reason: "unknown", position: pos });
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

function tick() {
	if (shuttingDown) return;
	if (bot && bot.entity) {
		lastSnapshot = buildSnapshot(bot);
		reflexCtx.snapshot = lastSnapshot;
		if (!reflexPaused) {
			runTick(reflexCtx);
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

function handleCommand(msg, send) {
	switch (msg.type) {
		case COMMAND_TYPES.PAUSE:
			reflexPaused = true;
			info("ipc", "reflex paused by client");
			send(EVENT_TYPES.LOG, { ts: new Date().toISOString(), level: "info", source: "ipc", text: "reflex paused" });
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
