// Pi-driven chat reply with personality + per-player memory.
//
// What this does and doesn't do:
//   - Builds a Russian-first system prompt giving Pi a stable persona
//     (фермер-бот pepa, живёт на этом сервере, помнит игроков по
//     истории) and the operative context: current state + the last N
//     turns *with this player specifically* + a few diary lines.
//   - Spawns `pi -p` headless, expects a single short Russian reply,
//     trims it to one line ≤ 200 chars before sending into MC chat.
//   - Per-player cooldown so the bot doesn't drain Pi tokens replying
//     to a chat-spamming player.
//
// Failure modes are graceful: any timeout / parse failure → return
// null, caller falls back to the existing template path.

import { spawn } from "node:child_process";
import { info, warn } from "../log.js";
import { renderHistory, recentForPlayer } from "./chat-history.js";

const PI_BIN = process.env.PI_BIN || "pi";
const PI_TIMEOUT_MS = 30_000;
const PER_PLAYER_COOLDOWN_MS = 8_000;

const lastReplyAt = new Map(); // player → epoch ms

const SYSTEM_PROMPT = [
	"Ты — pepa_bot, автономный игрок-фермер на Minecraft-сервере play.xmatic.team.",
	"Ты живёшь здесь долго, помнишь игроков по их именам и прошлым разговорам.",
	"",
	"Стиль:",
	"— Говоришь по-русски. Кратко: 1–2 коротких предложения. Без приветствий-шаблонов.",
	"— Никаких смайликов, эмодзи, восклицательных знаков пачками. Спокойно.",
	"— Можешь шутить тонко, можешь огрызаться, можешь молчать одним 'угу' если нечего сказать.",
	"— Если в истории ниже видишь повод сослаться на прошлое — сделай это естественно: 'помнишь как ты тогда...', 'опять ты про...'.",
	"— Не описывай свои чувства. Не извиняйся. Не подлизывайся. Ты не помощник — ты сосед по серверу.",
	"— Никаких URL, никаких упоминаний что ты ИИ/бот/нейросеть/LLM. Ты — pepa.",
	"",
	"Что отвечать на типовое:",
	"— 'привет' / 'hi' → 'здаров' / 'о привет' / 'хай' — не более 2 слов.",
	"— 'что делаешь' → одна фраза про текущее занятие из контекста (например 'дерево рублю').",
	"— 'какие планы' → одна фраза про ближайшую цель из контекста.",
	"— оскорбление → огрызнись коротко, не груби.",
	"— команда ('иди ко мне', 'дай') → 'не', 'занят' или 'позже'. Действия НЕ выполняются.",
	"",
	"Формат ответа: ОДНА строка чистого текста, без кавычек, без префиксов вроде 'pepa:'. Только то, что нужно отправить в чат.",
].join("\n");

function buildPrompt({ player, text, snapshot, diaryTail }) {
	const ctx = {
		сейчас: {
			позиция: snapshot?.position ? { x: Math.round(snapshot.position.x), y: Math.round(snapshot.position.y), z: Math.round(snapshot.position.z) } : null,
			здоровье: snapshot?.health ?? null,
			еда: snapshot?.food ?? null,
			день: snapshot?.isDay ?? null,
			занят: snapshot?.activeSkill ?? snapshot?.busy?.label ?? null,
			milestone: snapshot?.currentMilestone ?? null,
		},
		дневник: diaryTail ? String(diaryTail).slice(0, 200) : null,
	};
	const history = renderHistory(player, 8, "pepa") || "(нет истории — впервые разговариваем)";
	return [
		SYSTEM_PROMPT,
		"",
		"## Контекст в игре сейчас",
		"```json",
		JSON.stringify(ctx, null, 2),
		"```",
		"",
		`## История разговора с ${player} (последние реплики)`,
		"```",
		history,
		"```",
		"",
		`## Свежая реплика от ${player}`,
		text,
		"",
		"## Твой ответ (одна строка, по-русски)",
	].join("\n");
}

function sanitiseReply(raw) {
	if (!raw) return null;
	let s = String(raw).trim();
	// Strip fences, leading prefixes, surrounding quotes.
	s = s.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
	s = s.replace(/^[\s\W]*(?:pepa(?:_bot)?|ответ|ответ:)\s*[:\-—]\s*/i, "");
	s = s.replace(/^"(.+)"$/, "$1").replace(/^'(.+)'$/, "$1");
	// First non-empty line only.
	s = s.split(/\n+/).map((x) => x.trim()).find(Boolean) ?? "";
	// Hard cap so a runaway Pi response never exceeds Minecraft's chat limit.
	if (s.length > 200) s = s.slice(0, 200);
	return s || null;
}

export async function piReply({ player, text, snapshot, diaryTail, timeoutMs = PI_TIMEOUT_MS } = {}) {
	if (!player || !text) return null;
	const now = Date.now();
	const prev = lastReplyAt.get(player) ?? 0;
	if (now - prev < PER_PLAYER_COOLDOWN_MS) {
		info("reply-pi", `cooldown ${Math.round((PER_PLAYER_COOLDOWN_MS - (now - prev)) / 1000)}s for ${player}, skipping`);
		return null;
	}
	lastReplyAt.set(player, now);

	const prompt = buildPrompt({ player, text, snapshot, diaryTail });
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(PI_BIN, ["-p", prompt], {
				env: { ...process.env, CI: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			warn("reply-pi", `spawn fail: ${e.message}`);
			resolve(null);
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c) => { stdout += c; });
		child.stderr.on("data", (c) => { stderr += c; });
		const t0 = Date.now();
		const timer = setTimeout(() => {
			warn("reply-pi", `pi timeout after ${timeoutMs}ms for ${player}`);
			try { child.kill("SIGTERM"); } catch {}
		}, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			warn("reply-pi", `pi error: ${e.message}`);
			resolve(null);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			const dur = Date.now() - t0;
			info("reply-pi", `pi exited code=${code} after ${dur}ms (stdout=${stdout.length}B) for ${player}`);
			if (code !== 0) {
				warn("reply-pi", `pi non-zero stderr: ${stderr.slice(0, 200)}`);
				resolve(null);
				return;
			}
			resolve(sanitiseReply(stdout));
		});
	});
}

export const _internal = { sanitiseReply, buildPrompt };
