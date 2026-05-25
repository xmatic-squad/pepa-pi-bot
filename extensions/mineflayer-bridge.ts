import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Bot } from "mineflayer";

const require = createRequire(import.meta.url);
const dotenv = require("dotenv") as typeof import("dotenv");
const mineflayer = require("mineflayer") as typeof import("mineflayer");

type AuthMode = "offline" | "microsoft";
type AuthObservation =
	| "not-started"
	| "pending"
	| "none-detected"
	| "register-prompt-password-missing"
	| "login-prompt-password-missing"
	| "handled-register"
	| "handled-login";

interface BridgeConfig {
	host: string;
	port: number;
	username: string;
	auth: AuthMode;
	version: string | false;
	authmePassword: string;
	chatRateLimitPerMinute: number;
	stateDir: string;
	redactions: string[];
}

const CHAT_PARAMS = {
	type: "object",
	properties: {
		text: {
			type: "string",
			description: "Plain chat text or a slash command to send in Minecraft. Do not include secrets.",
		},
	},
	required: ["text"],
	additionalProperties: false,
} as const;

const EMPTY_PARAMS = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

function required(parsed: Record<string, string>, key: string): string {
	const value = parsed[key]?.trim();
	if (!value) throw new Error(`Missing required .env key: ${key}`);
	return value;
}

function sanitizePathSegment(value: string): string {
	const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	return cleaned.slice(0, 128) || "server";
}

function loadConfig(cwd: string): BridgeConfig {
	const envPath = resolve(cwd, ".env");
	if (!existsSync(envPath)) {
		throw new Error("Missing .env. Copy .env.example to .env and fill in the Minecraft settings.");
	}

	const envText = readFileSync(envPath, "utf8");
	const parsed = dotenv.parse(envText) as Record<string, string>;
	dotenv.config({ path: envPath });

	const host = required(parsed, "MC_HOST");
	const rawPort = required(parsed, "MC_PORT");
	const port = Number.parseInt(rawPort, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("MC_PORT must be an integer between 1 and 65535.");
	}

	const username = required(parsed, "MC_USERNAME");
	const authValue = required(parsed, "MC_AUTH_MODE").toLowerCase();
	if (authValue !== "offline" && authValue !== "microsoft") {
		throw new Error("MC_AUTH_MODE must be either offline or microsoft.");
	}

	const versionRaw = required(parsed, "MC_VERSION");
	const version = versionRaw.toLowerCase() === "auto" ? false : versionRaw;

	const chatLimitRaw = parsed.CHAT_RATE_LIMIT_PER_MIN?.trim() || "15";
	const chatRateLimitPerMinute = Number.parseInt(chatLimitRaw, 10);
	if (!Number.isInteger(chatRateLimitPerMinute) || chatRateLimitPerMinute < 1) {
		throw new Error("CHAT_RATE_LIMIT_PER_MIN must be a positive integer.");
	}

	const redactions = Object.values(parsed)
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.sort((a, b) => b.length - a.length);

	return {
		host,
		port,
		username,
		auth: authValue,
		version,
		authmePassword: parsed.MC_AUTHME_PASSWORD?.trim() || "",
		chatRateLimitPerMinute,
		stateDir: resolve(cwd, "state", sanitizePathSegment(`${host}_${port}`)),
		redactions,
	};
}

function stringifyUnknown(value: unknown): string {
	if (value instanceof Error) return value.stack || value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function redact(text: string, config: BridgeConfig | undefined): string {
	if (!config) return text;
	let result = text;
	for (const value of config.redactions) {
		result = result.split(value).join(`[redacted]`);
	}
	return result;
}

function truncate(text: string, maxLength = 800): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export default function mineflayerBridge(pi: ExtensionAPI) {
	let cwd = process.cwd();
	let config: BridgeConfig | undefined;
	let bot: Bot | undefined;
	let connecting = false;
	let authObservation: AuthObservation = "not-started";
	let authTimer: NodeJS.Timeout | undefined;
	let outgoingChatTimestamps: number[] = [];

	function log(event: string, detail?: unknown) {
		const suffix = detail === undefined ? "" : `: ${truncate(redact(stringifyUnknown(detail), config))}`;
		console.log(`[mineflayer-bridge] ${event}${suffix}`);
	}

	function ensureConfig(): BridgeConfig {
		if (!config) config = loadConfig(cwd);
		return config;
	}

	function flagPath(current: BridgeConfig): string {
		return resolve(current.stateDir, "joined-before.flag");
	}

	function markJoinedBefore(current: BridgeConfig) {
		const path = flagPath(current);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "joined-before\n", "utf8");
	}

	function hasJoinedBefore(current: BridgeConfig): boolean {
		return existsSync(flagPath(current));
	}

	function assertNoEnvLeak(text: string, current: BridgeConfig) {
		for (const value of current.redactions) {
			if (text.includes(value)) {
				throw new Error("Refusing to send Minecraft chat containing a value from .env.");
			}
		}
	}

	function enforceChatRateLimit(current: BridgeConfig) {
		const now = Date.now();
		outgoingChatTimestamps = outgoingChatTimestamps.filter((timestamp) => now - timestamp < 60_000);
		if (outgoingChatTimestamps.length >= current.chatRateLimitPerMinute) {
			throw new Error("Minecraft chat rate limit reached; wait before sending more chat.");
		}
		outgoingChatTimestamps.push(now);
	}

	function activeBot(): Bot {
		if (!bot) throw new Error("Mineflayer bot is not connected.");
		return bot;
	}

	function sendChat(text: string, options: { internalAuthCommand?: boolean } = {}) {
		const current = ensureConfig();
		if (!options.internalAuthCommand) assertNoEnvLeak(text, current);
		enforceChatRateLimit(current);
		activeBot().chat(text);
	}

	function stopAuthTimer() {
		if (authTimer) clearTimeout(authTimer);
		authTimer = undefined;
	}

	function startAuthDetection() {
		stopAuthTimer();
		authObservation = "pending";
		authTimer = setTimeout(() => {
			if (authObservation === "pending") {
				authObservation = "none-detected";
				log("auth", "no in-game auth prompt detected within 5s");
			}
		}, 5_000);
	}

	function maybeHandleAuthPrompt(messageText: string) {
		if (!bot) return;
		const current = ensureConfig();
		if (authObservation !== "pending") return;

		const lower = messageText.toLowerCase();
		const sawRegister = lower.includes("/register");
		const sawLogin = lower.includes("/login");
		if (!sawRegister && !sawLogin) return;

		stopAuthTimer();

		const promptKind = sawRegister && !sawLogin ? "register" : "login";
		if (!current.authmePassword) {
			authObservation = promptKind === "register" ? "register-prompt-password-missing" : "login-prompt-password-missing";
			log("auth", "in-game auth prompt detected, but MC_AUTHME_PASSWORD is empty");
			return;
		}

		const joinedBefore = hasJoinedBefore(current);
		const command = sawLogin ? "login" : joinedBefore ? "login" : "register";
		try {
			if (command === "register") {
				sendChat(`/register ${current.authmePassword} ${current.authmePassword}`, { internalAuthCommand: true });
				authObservation = "handled-register";
			} else {
				sendChat(`/login ${current.authmePassword}`, { internalAuthCommand: true });
				authObservation = "handled-login";
			}
			markJoinedBefore(current);
			log("auth", `handled ${command} prompt using configured password`);
		} catch (error) {
			log("auth-error", error);
		}
	}

	function connect() {
		if (bot || connecting) return;
		const current = ensureConfig();
		connecting = true;
		log("connecting", "opening Mineflayer connection to configured server");

		const nextBot = mineflayer.createBot({
			host: current.host,
			port: current.port,
			username: current.username,
			auth: current.auth,
			version: current.version,
			logErrors: false,
		});

		bot = nextBot;
		nextBot.once("login", () => {
			connecting = false;
		});
		nextBot.on("spawn", () => {
			connecting = false;
			log("spawn");
			startAuthDetection();
		});
		nextBot.on("message", (message) => {
			maybeHandleAuthPrompt(message.toString());
		});
		nextBot.on("kicked", (reason) => {
			log("kicked", reason);
		});
		nextBot.on("error", (error) => {
			connecting = false;
			stopAuthTimer();
			if (bot === nextBot) bot = undefined;
			try {
				nextBot.end("connection error");
			} catch {
				// Ignore close failures; the original error is logged below.
			}
			log("error", error);
		});
		nextBot.on("end", (reason) => {
			connecting = false;
			stopAuthTimer();
			if (bot === nextBot) bot = undefined;
			log("end", reason);
		});
	}

	function disconnect() {
		stopAuthTimer();
		if (!bot) return false;
		const currentBot = bot as Bot & { quit?: (reason?: string) => void; end?: (reason?: string) => void };
		bot = undefined;
		if (typeof currentBot.quit === "function") {
			currentBot.quit();
		} else if (typeof currentBot.end === "function") {
			currentBot.end("disconnect requested");
		}
		return true;
	}

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		try {
			ensureConfig();
			connect();
			if (ctx.hasUI) ctx.ui.setStatus("mineflayer", "mc: connecting");
		} catch (error) {
			log("startup-error", error);
			if (ctx.hasUI) ctx.ui.notify(redact(stringifyUnknown(error), config), "error");
		}
	});

	pi.on("session_shutdown", async () => {
		disconnect();
	});

	pi.registerTool({
		name: "mc_chat",
		label: "Minecraft Chat",
		description: "Send one Minecraft chat message or slash command through the connected Mineflayer bot. Rate-limited and refuses .env values.",
		promptSnippet: "Send one rate-limited Minecraft chat message or slash command.",
		promptGuidelines: [
			"Use mc_chat only for intentional Minecraft chat; never send secrets, .env values, passwords, API keys, or spam.",
		],
		parameters: CHAT_PARAMS,
		async execute(_toolCallId, params: { text: string }) {
			const text = params.text.trim();
			if (!text) throw new Error("mc_chat text must not be empty.");
			sendChat(text);
			return {
				content: [{ type: "text", text: "Sent one Minecraft chat message." }],
				details: { sent: true, length: text.length },
			};
		},
	});

	pi.registerTool({
		name: "mc_position",
		label: "Minecraft Position",
		description: "Return the connected bot's current Minecraft position and basic status without exposing .env values.",
		promptSnippet: "Report the bot's current Minecraft position and basic status.",
		parameters: EMPTY_PARAMS,
		async execute() {
			const currentBot = activeBot();
			const entity = currentBot.entity;
			if (!entity) {
				return {
					content: [{ type: "text", text: "Connected, but entity position is not available yet." }],
					details: { connected: true, authObservation },
				};
			}

			const position = {
				x: Number(entity.position.x.toFixed(3)),
				y: Number(entity.position.y.toFixed(3)),
				z: Number(entity.position.z.toFixed(3)),
			};

			return {
				content: [
					{
						type: "text",
						text: `Position: x=${position.x}, y=${position.y}, z=${position.z}; dimension=${currentBot.game.dimension}; auth=${authObservation}`,
					},
				],
				details: {
					connected: true,
					position,
					dimension: currentBot.game.dimension,
					health: currentBot.health,
					food: currentBot.food,
					gameMode: currentBot.game.gameMode,
					authObservation,
				},
			};
		},
	});

	pi.registerTool({
		name: "mc_disconnect",
		label: "Minecraft Disconnect",
		description: "Disconnect the Mineflayer bot and do not reconnect automatically.",
		promptSnippet: "Disconnect the Mineflayer bot without auto-reconnecting.",
		parameters: EMPTY_PARAMS,
		async execute() {
			const didDisconnect = disconnect();
			return {
				content: [{ type: "text", text: didDisconnect ? "Minecraft disconnect requested." : "Mineflayer bot was not connected." }],
				details: { disconnected: didDisconnect },
			};
		},
	});
}
