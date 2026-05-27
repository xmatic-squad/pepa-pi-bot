// Smoke test for the TIMEWEB_* fast-LLM env vars.
//
// Loads .env, asks the model a tiny structured question, prints
// {ok, latency, code, first 200 chars of reply}. No bot state is
// touched — this is purely a connectivity check.
//
// Usage:
//   node scripts/check-timeweb.js

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { complete, isAvailable, getConfig } from "../runtime/llm/provider.js";
import { advise, getUsageSnapshot, _resetForTest as resetAdvisor } from "../runtime/coach/fast-advisor.js";
import { tickAdvisor, consumeFreshRecommendation, _resetForTest as resetTrigger } from "../runtime/coach/advisor-trigger.js";

function redact(key) {
	if (!key) return "(unset)";
	if (key.length < 12) return "(set, short)";
	return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;
}

async function main() {
	console.log("=== TimeWeb / fast-advisor smoke test ===");
	const cfg = getConfig();
	console.log(`BASE_URL: ${cfg.baseUrl || "(unset)"}`);
	console.log(`API_KEY:  ${redact(cfg.apiKey)}`);
	console.log(`MODEL:    ${cfg.model || "(unset)"}`);
	console.log(`TIMEOUT:  ${cfg.timeoutMs}ms`);
	console.log(`isAvailable: ${isAvailable()}`);
	console.log("");

	if (!isAvailable()) {
		console.error("ERROR: TIMEWEB_API_KEY not set in .env — aborting.");
		process.exit(1);
	}

	console.log("→ probe 1: plain prompt, no JSON mode");
	const r1 = await complete({
		system: "Reply in 5 words or less.",
		user: "Say 'pepa hears you'.",
		json: false,
	});
	logResult(r1);

	console.log("");
	console.log("→ probe 2: JSON mode with a tiny structured request");
	const r2 = await complete({
		system: "Reply with strict JSON only.",
		user: 'Return {"alive": true, "name": "pepa"}',
		json: true,
	});
	logResult(r2);

	console.log("");
	console.log("→ probe 3: full fast-advisor stack (registry injection + skill validation)");
	resetAdvisor();
	const r3 = await advise({
		snapshot: {
			position: { x: 608, y: 90, z: 91 },
			health: 14, food: 18, isDay: true,
			inventory: { dirt: 4 },
			activeSkill: "explore.far",
		},
		reason: "wedged_60s",
		recentSkillIds: ["explore.far", "explore.far", "explore.far", "explore.far"],
		lessonsTail: [
			{ text: "Если позиция почти не меняется и инвентарь не растёт, прекращай текущий exploration skill." },
		],
		force: true,
	});
	console.log(`  ok:       ${r3.ok}`);
	console.log(`  latency:  ${r3.latencyMs}ms`);
	if (r3.ok) {
		console.log(`  action:   ${r3.action}`);
		console.log(`  skillId:  ${r3.skillId ?? "(n/a)"}`);
		console.log(`  why:      ${r3.rationale}`);
		if (r3.usage) {
			console.log(`  tokens:   in=${r3.usage.in} out=${r3.usage.out} total=${r3.usage.total}`);
		}
	} else {
		console.log(`  code:     ${r3.code}`);
		console.log(`  detail:   ${String(r3.detail).slice(0, 200)}`);
	}

	console.log("");
	console.log("→ probe 4: auto-trigger flow (tickAdvisor → wait → consumeFreshRecommendation)");
	resetAdvisor();
	resetTrigger();
	const ctx = {
		snapshot: { position: { x: 608, y: 90, z: 91 }, health: 14, food: 18, isDay: true,
			inventory: { dirt: 4 }, activeSkill: "explore.far" },
		recentSkillIds: ["explore.far", "explore.far", "explore.far", "explore.far"],
		lastSignificantMoveAt: Date.now() - 90_000,
	};
	const t = tickAdvisor(ctx, { plannedSkillId: "explore.far" });
	console.log(`  trigger fired: ${t.fired} (${t.reason})`);
	// wait up to 25s for async advise to land
	const waitStart = Date.now();
	while (!ctx.advisorRecommendation && Date.now() - waitStart < 25_000) {
		await new Promise((r) => setTimeout(r, 200));
	}
	const consumed = consumeFreshRecommendation(ctx);
	if (consumed) {
		console.log(`  recommendation: ${consumed.skillId}`);
		console.log(`  rationale:      ${consumed.rationale}`);
		console.log(`  latency:        ${consumed.latencyMs}ms`);
		if (consumed.usage) {
			console.log(`  tokens:         in=${consumed.usage.in} out=${consumed.usage.out} total=${consumed.usage.total}`);
		}
	} else {
		console.log(`  no recommendation (timeout or non-switch action)`);
	}

	console.log("");
	console.log("=== Usage budget summary ===");
	const usage = getUsageSnapshot();
	console.log(`  calls (last hour): ${usage.callsLastHour}/${usage.hourlyBudget}`);
	console.log(`  calls total:       ${usage.callsTotal}`);
	console.log(`  tokens in (total): ${usage.tokensInTotal}`);
	console.log(`  tokens out (total): ${usage.tokensOutTotal}`);
	// Rough cost estimate for context — TimeWeb pricing unknown, OpenAI
	// gpt-5-mini hypothetical: $0.15/M input + $0.60/M output.
	const estUsd = (usage.tokensInTotal * 0.15 + usage.tokensOutTotal * 0.60) / 1_000_000;
	console.log(`  est. cost (OpenAI gpt-5-mini pricing): $${estUsd.toFixed(6)}`);
	console.log(`  per-call avg in:  ${Math.round(usage.tokensInTotal / Math.max(1, usage.callsTotal))}t`);
	console.log(`  hourly @ budget:  ${Math.round(usage.tokensInTotal / Math.max(1, usage.callsTotal)) * usage.hourlyBudget}t in / ${Math.round(usage.tokensOutTotal / Math.max(1, usage.callsTotal)) * usage.hourlyBudget}t out`);
}

function logResult(r) {
	console.log(`  ok:       ${r.ok}`);
	console.log(`  latency:  ${r.latencyMs}ms`);
	if (!r.ok) {
		console.log(`  code:     ${r.code}`);
		console.log(`  detail:   ${String(r.detail).slice(0, 400)}`);
		return;
	}
	console.log(`  reply:    ${typeof r.text === "string" ? r.text.slice(0, 200) : JSON.stringify(r.text).slice(0, 200)}`);
}

main().catch((e) => {
	console.error("UNHANDLED:", e?.message ?? e);
	process.exit(2);
});
