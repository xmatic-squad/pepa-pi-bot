import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..");

loadDotenv({ path: path.join(REPO_ROOT, ".env") });

function req(name) {
	const v = process.env[name]?.trim();
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

function opt(name, fallback = "") {
	return process.env[name]?.trim() || fallback;
}

const host = req("MC_HOST");
const port = Number.parseInt(opt("MC_PORT", "25565"), 10);
const username = req("MC_USERNAME");

// MC_VERSION: "auto" (or empty) lets mineflayer auto-detect from the server
// handshake — the right default per the survival-bot PRD (no hard-coded modern
// version unless the server requires pinning). Mineflayer accepts `false` to
// auto-detect, so we translate "auto" into false at the boundary; the original
// string is preserved for logging.
const rawVersion = opt("MC_VERSION", "auto");
const mineflayerVersion = rawVersion.toLowerCase() === "auto" ? false : rawVersion;

export const config = Object.freeze({
	host,
	port,
	username,
	version: rawVersion,
	mineflayerVersion,
	authMode: opt("MC_AUTH_MODE", "offline"),
	authmePassword: opt("MC_AUTHME_PASSWORD", ""),
	operators: opt("OPERATOR_USERNAMES", "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean),
	tickIntervalMs: Math.max(1, Number.parseInt(opt("TICK_INTERVAL_SECONDS", "3"), 10)) * 1000,
	chatRateLimitPerMin: Number.parseInt(opt("CHAT_RATE_LIMIT_PER_MIN", "15"), 10),
});

export const serverKey = `${host}_${port}`;
export const stateDir = path.join(REPO_ROOT, "state", serverKey);
export const socketPath = path.join(stateDir, "bot.sock");

// Redacted env view for logs — never include the AuthMe password.
export function redactedConfig() {
	const { authmePassword, ...rest } = config;
	return { ...rest, authmePassword: authmePassword ? "***" : "(unset)" };
}
