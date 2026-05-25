// Unix-socket server that exposes the bot to local TUI clients.
// One server can hold N clients; events are broadcast to all of them.
// All frames are JSON + newline. See ipc-protocol.js for the contract.

import fs from "node:fs";
import net from "node:net";
import { createLineParser, encodeFrame, EVENT_TYPES } from "./ipc-protocol.js";
import { socketPath } from "./config.js";
import { info, warn, recentLogs, onLog } from "./log.js";

export function createIpcServer({ getStatusSnapshot, onCommand }) {
	// Clean stale socket if a previous run crashed before cleanup.
	try {
		fs.unlinkSync(socketPath);
	} catch (e) {
		if (e.code !== "ENOENT") warn("ipc", `could not unlink stale socket: ${e.message}`);
	}

	const clients = new Set();

	const server = net.createServer((socket) => {
		clients.add(socket);
		info("ipc", `client connected (total=${clients.size})`);

		const send = (type, payload) => {
			try {
				socket.write(encodeFrame({ type, ts: new Date().toISOString(), payload }));
			} catch {}
		};

		// On hello: send current snapshot + recent logs so the TUI can render
		// immediately without waiting for the next tick.
		send(EVENT_TYPES.HELLO, {
			snapshot: getStatusSnapshot(),
			recentLogs: recentLogs(50),
		});

		const parser = createLineParser((obj) => {
			if (obj.__parseError) {
				warn("ipc", `bad frame from client: ${obj.err}`);
				return;
			}
			onCommand?.(obj, send);
		});

		socket.on("data", parser);
		socket.on("close", () => {
			clients.delete(socket);
			info("ipc", `client disconnected (total=${clients.size})`);
		});
		socket.on("error", (err) => {
			warn("ipc", `client error: ${err?.message ?? err}`);
		});
	});

	server.on("error", (err) => {
		warn("ipc", `server error: ${err?.message ?? err}`);
	});

	server.listen(socketPath, () => {
		fs.chmodSync(socketPath, 0o600);
		info("ipc", `listening on ${socketPath}`);
	});

	// Forward every log entry to all subscribed clients.
	const unsubLog = onLog((entry) => broadcast(EVENT_TYPES.LOG, entry));

	function broadcast(type, payload) {
		const frame = encodeFrame({ type, ts: new Date().toISOString(), payload });
		for (const c of clients) {
			try {
				c.write(frame);
			} catch {}
		}
	}

	function close() {
		unsubLog();
		for (const c of clients) c.destroy();
		clients.clear();
		server.close();
		try {
			fs.unlinkSync(socketPath);
		} catch {}
	}

	return { broadcast, close };
}
