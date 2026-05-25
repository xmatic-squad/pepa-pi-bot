// Ring-buffered log with fan-out: stdout + IPC broadcast + on-disk daily file.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./config.js";

const LOGS_DIR = path.join(stateDir, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

const RING_SIZE = 500;
const ring = []; // newest at end

const subscribers = new Set(); // fn(entry)

function todayStamp() {
	return new Date().toISOString().slice(0, 10);
}

function dailyLogPath() {
	return path.join(LOGS_DIR, `${todayStamp()}.log`);
}

function appendDisk(entry) {
	const line = `${entry.ts} [${entry.level}] ${entry.source}: ${entry.text}\n`;
	try {
		fs.appendFileSync(dailyLogPath(), line);
	} catch {
		// disk full or read-only — give up silently to avoid log-of-log loops
	}
}

export function log(level, source, text, details) {
	const entry = {
		ts: new Date().toISOString(),
		level,
		source,
		text: typeof text === "string" ? text : JSON.stringify(text),
		details,
	};
	ring.push(entry);
	if (ring.length > RING_SIZE) ring.shift();

	// stdout mirror
	const prefix = `[${entry.ts}] [${level}] ${source}:`;
	const line = `${prefix} ${entry.text}`;
	if (level === "error") console.error(line);
	else console.log(line);

	appendDisk(entry);

	for (const sub of subscribers) {
		try {
			sub(entry);
		} catch {}
	}
	return entry;
}

export const info = (src, msg, d) => log("info", src, msg, d);
export const warn = (src, msg, d) => log("warn", src, msg, d);
export const error = (src, msg, d) => log("error", src, msg, d);
export const debug = (src, msg, d) => log("debug", src, msg, d);

export function recentLogs(n = 50) {
	return ring.slice(-n);
}

export function onLog(fn) {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}
