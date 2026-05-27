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
import { advise, _resetForTest as resetAdvisor } from "../runtime/coach/fast-advisor.js";

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
	} else {
		console.log(`  code:     ${r3.code}`);
		console.log(`  detail:   ${String(r3.detail).slice(0, 200)}`);
	}
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
