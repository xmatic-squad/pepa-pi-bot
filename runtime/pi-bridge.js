// Spawn `pi -p "<prompt>"` as a one-shot subprocess and stream stdout/stderr
// to the caller. Used for headless escalation: the bot's reflex / TUI can ask
// Pi a single question without keeping a long-lived TUI session open.

import { spawn } from "node:child_process";
import { info, warn } from "./log.js";

// Resolve `pi` lazily — user has it on PATH via vite-plus shim.
const PI_BIN = process.env.PI_BIN || "pi";

export function askPi({ prompt, onChunk, onDone, cwd, signal }) {
	const startedAt = Date.now();
	info("pi-bridge", `spawning pi -p (${prompt.length} chars)`);

	const child = spawn(PI_BIN, ["-p", prompt], {
		cwd: cwd || process.cwd(),
		env: { ...process.env, CI: "1" },
		stdio: ["ignore", "pipe", "pipe"],
		signal,
	});

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	child.stdout.on("data", (chunk) => {
		onChunk?.({ stream: "stdout", text: chunk });
	});
	child.stderr.on("data", (chunk) => {
		onChunk?.({ stream: "stderr", text: chunk });
	});

	child.on("error", (err) => {
		warn("pi-bridge", `pi subprocess failed to start: ${err?.message ?? err}`);
		onDone?.({ code: -1, durationMs: Date.now() - startedAt, error: String(err) });
	});

	child.on("exit", (code) => {
		const durationMs = Date.now() - startedAt;
		info("pi-bridge", `pi exited code=${code} after ${durationMs}ms`);
		onDone?.({ code: code ?? -1, durationMs });
	});

	return child;
}
