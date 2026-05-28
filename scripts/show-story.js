#!/usr/bin/env node
// Operator-facing view of the bot's storyline progress.
//
// Reads the bot's IPC sock if available (live snapshot), else falls
// back to "what would the picker say given an empty inventory". The
// useful form is the live one.
//
// Usage:
//   node scripts/show-story.js            # live snapshot via IPC
//   node scripts/show-story.js --plain    # show static catalogue

import { config as loadDotenv } from "dotenv";
loadDotenv();

import net from "node:net";
import { STORYLINE } from "../runtime/goal/storyline.js";
import { pickCurrentStep, progressSummary, _resetForTest } from "../runtime/goal/state.js";
import { socketPath } from "../runtime/config.js";
import { COMMAND_TYPES, EVENT_TYPES } from "../runtime/ipc-protocol.js";

function plainCatalogue() {
	console.log("=== Storyline (canonical Minecraft survival arc) ===");
	for (let i = 0; i < STORYLINE.length; i++) {
		const s = STORYLINE[i];
		console.log(`  ${(i + 1).toString().padStart(2)}. ${s.id.padEnd(20)} ${s.title}`);
		console.log(`      → ${s.narration_ru}`);
	}
}

async function fetchSnapshotViaIpc() {
	return new Promise((resolve) => {
		const sock = net.connect(socketPath);
		const buf = [];
		const timer = setTimeout(() => { sock.destroy(); resolve(null); }, 1500);
		sock.on("connect", () => {
			sock.write(JSON.stringify({ type: COMMAND_TYPES.SNAPSHOT }) + "\n");
		});
		const parse = () => {
			try {
				const raw = Buffer.concat(buf).toString("utf8").trim();
				const lines = raw.split("\n").filter(Boolean);
				for (const ln of lines) {
					const obj = JSON.parse(ln);
					if (obj?.type === EVENT_TYPES.STATUS && obj?.payload) {
						clearTimeout(timer);
						sock.destroy();
						resolve(obj.payload);
						return true;
					}
				}
			} catch {}
			return false;
		};
		sock.on("data", (chunk) => {
			buf.push(chunk);
			parse();
		});
		sock.on("end", () => {
			clearTimeout(timer);
			if (!parse()) resolve(null);
		});
		sock.on("error", () => { clearTimeout(timer); resolve(null); });
	});
}

async function main() {
	if (process.argv.includes("--plain")) {
		plainCatalogue();
		return;
	}

	const snap = await fetchSnapshotViaIpc();
	if (!snap) {
		console.log("(bot IPC not reachable — showing static catalogue)");
		console.log("");
		plainCatalogue();
		return;
	}

	_resetForTest();
	const cur = pickCurrentStep(snap);
	console.log(`=== Storyline progress (live snapshot) ===`);
	console.log(progressSummary(snap));
	console.log("");
	if (!cur) {
		console.log("(disconnected)");
		return;
	}
	for (let i = 0; i < STORYLINE.length; i++) {
		const s = STORYLINE[i];
		const mark = i < cur.index ? "✓" : (i === cur.index ? "→" : " ");
		const tag = i === cur.index ? ` (${cur.suggestion?.skillId ?? "-"})${cur.emergency ? " [PAUSED]" : ""}` : "";
		console.log(`  ${mark} ${(i + 1).toString().padStart(2)}. ${s.id.padEnd(20)} ${s.title}${tag}`);
	}
	console.log("");
	console.log(`Inventory keys: ${snap.inventory ? Object.keys(snap.inventory).slice(0, 12).join(", ") : "(empty)"}`);
	console.log(`HP ${snap.health ?? "?"} / food ${snap.food ?? "?"} / day=${snap.isDay ? "yes" : "no"}`);
}

main().catch((e) => {
	console.error("ERROR:", e?.message ?? e);
	process.exit(1);
});
