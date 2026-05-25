// Thin client wrapper around the Unix-socket IPC server. Emits events as a
// regular EventEmitter so the React layer can subscribe.

import net from "node:net";
import { EventEmitter } from "node:events";
import { createLineParser, encodeFrame } from "../runtime/ipc-protocol.js";
import { socketPath } from "../runtime/config.js";

export function createIpcClient() {
	const ee = new EventEmitter();
	let socket = null;
	let reconnectTimer = null;
	let shuttingDown = false;

	function connect() {
		if (socket || shuttingDown) return;
		socket = net.createConnection(socketPath);
		const parser = createLineParser((obj) => {
			if (obj.__parseError) {
				ee.emit("error", new Error(`bad frame: ${obj.err}`));
				return;
			}
			ee.emit("frame", obj);
			if (obj.type) ee.emit(obj.type, obj.payload, obj.ts);
		});
		socket.setEncoding("utf8");
		socket.on("connect", () => ee.emit("connected"));
		socket.on("data", parser);
		socket.on("close", () => {
			socket = null;
			ee.emit("disconnected");
			if (!shuttingDown) scheduleReconnect();
		});
		socket.on("error", (err) => {
			ee.emit("ipc-error", err);
		});
	}

	function scheduleReconnect() {
		if (reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, 1500);
	}

	function send(type, payload) {
		if (!socket || socket.destroyed) return false;
		try {
			socket.write(encodeFrame({ type, payload }));
			return true;
		} catch {
			return false;
		}
	}

	function close() {
		shuttingDown = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		socket?.destroy();
	}

	connect();

	return Object.assign(ee, { send, close });
}
