#!/usr/bin/env node
// Operator-facing view of bot-flagged improvement requests.
//
// The LLM (postmortem + reflect + trigger-tuner) writes here when it
// notices a structural gap — a missing skill or a misconfigured policy.
// You read this, decide what's worth implementing, and ship it.
//
// Usage:
//   node scripts/list-improvements.js                   # all open, sorted by priority
//   node scripts/list-improvements.js --status all       # everything
//   node scripts/list-improvements.js --status implemented
//   node scripts/list-improvements.js --source reflect
//   node scripts/list-improvements.js --category skill
//   node scripts/list-improvements.js --done 17 "shipped in 0.3.1"
//   node scripts/list-improvements.js --reject 18 "duplicate"
//   node scripts/list-improvements.js --stats           # aggregate counts

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { initKnowledge, listImprovements, markImprovementStatus, isAvailable, recommendationStats } from "../runtime/knowledge/index.js";
import { stateDir } from "../runtime/config.js";

function parseArgs(argv) {
	const out = { status: "open", source: null, category: null, limit: 50, stats: false, action: null };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--status") out.status = argv[++i];
		else if (a === "--source") out.source = argv[++i];
		else if (a === "--category") out.category = argv[++i];
		else if (a === "--limit") out.limit = Number(argv[++i]) || 50;
		else if (a === "--stats") out.stats = true;
		else if (a === "--done") { out.action = "implemented"; out.actionId = Number(argv[++i]); out.actionNote = argv[++i] ?? null; }
		else if (a === "--reject") { out.action = "rejected"; out.actionId = Number(argv[++i]); out.actionNote = argv[++i] ?? null; }
		else if (a === "--inprogress") { out.action = "in_progress"; out.actionId = Number(argv[++i]); out.actionNote = argv[++i] ?? null; }
		else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
	}
	if (out.status === "all") out.status = null;
	return out;
}

function printHelp() {
	console.log(`Usage: node scripts/list-improvements.js [options]

  --status <open|in_progress|implemented|rejected|all>  default: open
  --source <postmortem|reflect|advisor|tuner|manual>
  --category <skill|tuning|perception|planning|social|other>
  --limit <n>                                            default: 50
  --stats                                                show advisor recommendation stats
  --done <id> [note]                                     mark a request as implemented
  --inprogress <id> [note]                               mark a request as in progress
  --reject <id> [note]                                   mark a request as rejected
`);
}

function priorityLabel(p) {
	return ["", "P1 urgent", "P2 high", "P3 normal", "P4 low", "P5 nice-to-have"][p] ?? `P${p}`;
}

function statusLabel(s) {
	return ({
		open: "OPEN",
		in_progress: "WIP",
		implemented: "DONE",
		rejected: "REJECTED",
		duplicate: "DUP",
	})[s] ?? s;
}

function formatTs(ts) {
	if (!ts) return "?";
	const d = new Date(ts);
	return d.toISOString().slice(0, 16).replace("T", " ");
}

function renderRow(r) {
	const lines = [
		`#${r.id} [${statusLabel(r.status).padEnd(8)}] ${priorityLabel(r.priority).padEnd(18)} ×${r.votes}`,
		`        ${r.title}`,
		`        source=${r.source} category=${r.category ?? "?"} created=${formatTs(r.ts)}${r.implemented_at ? ` done=${formatTs(r.implemented_at)}` : ""}`,
	];
	if (r.description) {
		lines.push(`        ${String(r.description).slice(0, 240)}`);
	}
	if (r.notes) {
		lines.push(`        notes: ${String(r.notes).slice(0, 200)}`);
	}
	return lines.join("\n");
}

async function main() {
	const args = parseArgs(process.argv);
	await initKnowledge({ stateDir });
	if (!isAvailable()) {
		console.error(`knowledge DB unavailable at ${stateDir}/knowledge.db`);
		console.error(`(install better-sqlite3 and ensure the bot has run at least once)`);
		process.exit(1);
	}

	if (args.action) {
		markImprovementStatus(args.actionId, { status: args.action, notes: args.actionNote });
		console.log(`#${args.actionId} → ${args.action}${args.actionNote ? ` (${args.actionNote})` : ""}`);
		return;
	}

	if (args.stats) {
		const stats = recommendationStats({ sinceHours: 24 });
		console.log(`=== Advisor recommendation stats (last 24h) ===`);
		if (stats.length === 0) {
			console.log("(no recommendations yet)");
		} else {
			console.log("  trigger_reason         total  applied  ok  fail  avg_in  avg_out  avg_latency");
			for (const s of stats) {
				console.log(`  ${(s.trigger_reason || "?").padEnd(22)} ${String(s.total).padStart(5)}  ${String(s.applied ?? 0).padStart(7)}  ${String(s.succeeded ?? 0).padStart(2)}  ${String(s.failed ?? 0).padStart(4)}  ${String(Math.round(s.avg_in ?? 0)).padStart(6)}  ${String(Math.round(s.avg_out ?? 0)).padStart(7)}  ${String(Math.round(s.avg_latency_ms ?? 0)).padStart(11)}`);
			}
		}
		return;
	}

	const rows = listImprovements({
		status: args.status,
		source: args.source,
		category: args.category,
		limit: args.limit,
	});
	const heading = `=== Improvement requests`
		+ (args.status ? ` (status=${args.status})` : ` (all)`)
		+ (args.source ? ` source=${args.source}` : "")
		+ (args.category ? ` category=${args.category}` : "")
		+ ` — ${rows.length} row${rows.length === 1 ? "" : "s"} ===`;
	console.log(heading);
	if (rows.length === 0) {
		console.log("(empty)");
		return;
	}
	for (const r of rows) {
		console.log("");
		console.log(renderRow(r));
	}
}

main().catch((e) => {
	console.error("ERROR:", e?.message ?? e);
	process.exit(2);
});
