// Critic pass — adapted from Voyager's critic.txt.
//
// Before we file an auto-improvement proposal, ask Pi to look at the
// state + recent attempts and answer: "did the bot actually fail, and if
// so what should the patcher focus on?". Returns a JSON {reasoning,
// success, critique}. The proposal body then embeds the critique so the
// downstream auto-patch run has a sharp spec instead of raw metrics.
//
// Why a separate Pi call rather than baking it into the patch prompt:
//   * the patcher is biased toward writing code; the critic is biased
//     toward judging behaviour. Different prompt, different output.
//   * we cache the critique on the proposal, so the patcher can re-read
//     it without re-spending Pi tokens.
//   * if the critic says success=true, we DO NOT file the proposal at
//     all — the bot may have already recovered between when the stuck
//     detector tripped and now, and a false positive proposal just
//     burns Pi tokens.
//
// Failure modes are graceful: if Pi is missing, times out, or the JSON
// can't be parsed, we return null and the caller files the proposal
// without a critique section. Better to be slightly noisier than to
// drop a real stuck incident.

import { spawn } from "node:child_process";
import { info, warn } from "./log.js";

const PI_BIN = process.env.PI_BIN || "pi";
const DEFAULT_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = [
	"You are the critic for an autonomous Minecraft bot.",
	"",
	"You will receive a snapshot of the bot's state, the last skill result,",
	"recent scenario memory, and the milestone it is trying to reach. Decide",
	"whether the bot actually failed or merely paused, and if it failed,",
	"give a short, surgical critique a code-patching agent can act on.",
	"",
	"Respond with ONE JSON object — no prose, no markdown fence — matching:",
	'{ "reasoning": string, "success": boolean, "critique": string }',
	"",
	"Rules:",
	"- `success: true` ONLY if the bot's current state already satisfies the",
	"  milestone. (e.g. milestone = chop 1 log AND inventory shows ≥1 log).",
	"- `critique` ≤ 300 chars, imperative voice, must name the specific code",
	"  area or skill to change (e.g. \"gather.logs blacklists the target",
	"  on the first silent_dig_failure — clear blacklist after movement\").",
	"- Do not invent file paths. If you don't know which file, name the skill",
	"  id instead and let the patcher resolve.",
	"- No trailing commas, no single quotes — must parse with JSON.parse.",
	"",
	"Examples:",
	'INPUT: {"milestone":"chop 1 log","inventory":{"dirt":1},"lastResult":"gather.logs → no_target","scenarioTail":["gather.logs FAIL no_target ×5"]}',
	'OUTPUT: {"reasoning":"Bot has no logs and gather.logs returns no_target repeatedly while standing on dark_oak_leaves. findBlock callback matcher is broken under ViaBackwards.","success":false,"critique":"Switch gather.logs from bot.findBlock callback matcher to numeric-id matching via runtime/perception.js (see chopNearestTree)."}',
	"",
	'INPUT: {"milestone":"chop 1 log","inventory":{"oak_log":2},"lastResult":"gather.logs → done","scenarioTail":["gather.logs OK done"]}',
	'OUTPUT: {"reasoning":"Inventory already has 2 oak_log, exceeding the 1-log goal.","success":true,"critique":""}',
].join("\n");

function buildUserBlock({ snapshot, lastResult, scenarioTail, milestone, kind }) {
	const slim = {
		kind,
		milestone: milestone ?? null,
		position: snapshot?.position ?? null,
		health: snapshot?.health ?? null,
		food: snapshot?.food ?? null,
		isDay: snapshot?.isDay ?? null,
		inventory: snapshot?.inventory ?? {},
		closestHostile: snapshot?.closestHostile ?? null,
		lastResult: lastResult
			? {
				label: lastResult.label,
				ok: !!lastResult.ok,
				code: lastResult.code ?? null,
				detail: typeof lastResult.detail === "string"
					? lastResult.detail.slice(0, 200)
					: lastResult.detail,
			}
			: null,
		scenarioTail: Array.isArray(scenarioTail)
			? scenarioTail.slice(-10).map((e) => `${e.skillId} ${e.ok ? "OK" : "FAIL"} ${e.code ?? ""}`)
			: [],
	};
	return `INPUT:\n${JSON.stringify(slim)}\nOUTPUT:`;
}

// Strip a ```json fence or a leading "OUTPUT:" if Pi adds one anyway.
function extractJsonObject(text) {
	if (!text) return null;
	let s = String(text).trim();
	s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	s = s.replace(/^OUTPUT:\s*/i, "");
	// Find the first balanced {...}
	const first = s.indexOf("{");
	if (first < 0) return null;
	let depth = 0;
	for (let i = first; i < s.length; i++) {
		const c = s[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				const candidate = s.slice(first, i + 1);
				try { return JSON.parse(candidate); } catch { return null; }
			}
		}
	}
	return null;
}

export async function requestCritique({ snapshot, lastResult, scenarioTail, milestone, kind, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const prompt = `${SYSTEM_PROMPT}\n\n${buildUserBlock({ snapshot, lastResult, scenarioTail, milestone, kind })}`;
	return new Promise((resolve) => {
		const startedAt = Date.now();
		let child;
		try {
			child = spawn(PI_BIN, ["-p", prompt], {
				env: { ...process.env, CI: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			warn("critic", `spawn failed: ${e.message}`);
			resolve(null);
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c) => { stdout += c; });
		child.stderr.on("data", (c) => { stderr += c; });
		const timer = setTimeout(() => {
			warn("critic", `pi timeout after ${timeoutMs}ms — killing`);
			try { child.kill("SIGTERM"); } catch {}
		}, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			warn("critic", `pi error: ${e.message}`);
			resolve(null);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			const dur = Date.now() - startedAt;
			info("critic", `pi exited code=${code} after ${dur}ms (stdout=${stdout.length}B)`);
			if (code !== 0) {
				warn("critic", `pi non-zero: stderr=${stderr.slice(0, 200)}`);
				resolve(null);
				return;
			}
			const parsed = extractJsonObject(stdout);
			if (!parsed || typeof parsed.success !== "boolean") {
				warn("critic", `unparseable output: ${stdout.slice(0, 200)}`);
				resolve(null);
				return;
			}
			resolve({
				reasoning: String(parsed.reasoning ?? "").slice(0, 500),
				success: !!parsed.success,
				critique: String(parsed.critique ?? "").slice(0, 500),
				durationMs: dur,
			});
		});
	});
}

// Pure helper exported for tests.
export const _internal = { extractJsonObject, buildUserBlock };
