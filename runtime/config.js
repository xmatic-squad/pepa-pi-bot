import { config as loadDotenv } from "dotenv";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..");

loadDotenv({ path: path.join(REPO_ROOT, ".env") });

// v0.2.0-rc.2: detect that we're running under the node test runner so the
// log / scenario-memory / world-journal / knowledge modules redirect their
// writes to a tmp dir instead of the live state/<host>/ directory. Without
// this guard, every `npm test` poisons live scenarios.jsonl, world-journal,
// and the daily log file — and the learning loop can pick test rows up as
// real experience.
function detectTestContext() {
	if (process.env.PEPA_STATE_DIR) return process.env.PEPA_STATE_DIR;
	const execArgv = process.execArgv || [];
	const argv = process.argv || [];
	const isNodeTest = execArgv.includes("--test")
		|| argv.includes("--test")
		|| argv.some((a) => typeof a === "string" && /\.test\.[mc]?[jt]sx?$/.test(a));
	if (isNodeTest) {
		return path.join(os.tmpdir(), `pepa-test-state-${process.pid}`);
	}
	return null;
}
const TEST_STATE_DIR = detectTestContext();

function req(name) {
	const v = process.env[name]?.trim();
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

function opt(name, fallback = "") {
	return process.env[name]?.trim() || fallback;
}

function optInt(name, fallback) {
	const raw = Number.parseInt(opt(name, String(fallback)), 10);
	return Number.isFinite(raw) ? raw : fallback;
}

const host = req("MC_HOST");
const port = Number.parseInt(opt("MC_PORT", "25565"), 10);
const username = req("MC_USERNAME");
const learningMode = opt("PEPA_LEARNING_MODE", "normal").toLowerCase();
const fastLearning = learningMode === "fast" || learningMode === "dev";

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
	learningMode,
	stuckThresholdMs: Math.max(15, optInt("PEPA_STUCK_THRESHOLD_SECONDS", fastLearning ? 60 : 300)) * 1000,
	stuckCooldownMs: Math.max(60, optInt("PEPA_STUCK_COOLDOWN_SECONDS", fastLearning ? 600 : 1800)) * 1000,
	autoImproveCooldownMs: Math.max(60, optInt("PEPA_AUTO_IMPROVE_COOLDOWN_SECONDS", fastLearning ? 300 : 900)) * 1000,
	autoImproveMaxPerHour: Math.max(1, optInt("PEPA_AUTO_IMPROVE_MAX_PER_HOUR", fastLearning ? 8 : 4)),
	// Optional prismarine-viewer port for local visual debugging. 0/empty = off.
	viewerPort: (() => {
		const v = Number.parseInt(opt("VIEWER_PORT", "0"), 10);
		return Number.isFinite(v) && v > 0 ? v : 0;
	})(),
});

export const serverKey = `${host}_${port}`;
// Tests get an isolated tmp dir so they don't pollute live scenarios/journal/log.
// Override via PEPA_STATE_DIR if you need a custom location.
export const stateDir = TEST_STATE_DIR
	? path.resolve(TEST_STATE_DIR)
	: path.join(REPO_ROOT, "state", serverKey);
export const isTestStateDir = !!TEST_STATE_DIR;
export const socketPath = path.join(stateDir, "bot.sock");

// Redacted env view for logs — never include the AuthMe password.
export function redactedConfig() {
	const { authmePassword, ...rest } = config;
	return { ...rest, authmePassword: authmePassword ? "***" : "(unset)" };
}
