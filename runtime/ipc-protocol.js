// Shared IPC contract between runtime/bot.js (server) and tui/tui.tsx (client).
// Frame format: one JSON object per line over a Unix-domain socket.
// Socket path: state/<server-key>/bot.sock (created by server, removed on shutdown).

export const SOCKET_BASENAME = "bot.sock";

// Server → client messages.
export const EVENT_TYPES = Object.freeze({
	STATUS: "status", // periodic snapshot (HP/food/pos/task/connection)
	LOG: "log", // free-form log line { level, source, text }
	CHAT: "chat", // MC chat { from, text, kind: "player" | "system" }
	DEATH: "death", // death event { reason, position }
	ERROR: "error", // recoverable runtime error { source, text }
	ASK_PI_CHUNK: "ask-pi-chunk", // streamed stdout chunk from Pi subprocess
	ASK_PI_DONE: "ask-pi-done", // Pi subprocess exited { code, durationMs }
	HELLO: "hello", // sent on client connect with current snapshot
	PROPOSAL: "proposal", // pending proposal payload { filename, body }
});

// Client → server commands.
export const COMMAND_TYPES = Object.freeze({
	PAUSE: "cmd:pause", // reflex loop stops ticking; connection stays
	RESUME: "cmd:resume", // reflex loop resumes
	STOP: "cmd:stop", // graceful disconnect + process exit
	CHAT: "cmd:chat", // { text } sent into MC as bot
	ASK_PI: "cmd:ask-pi", // { prompt } spawn `pi -p` and stream output
	SNAPSHOT: "cmd:snapshot", // request immediate STATUS event
	PROPOSAL_LATEST: "cmd:proposal-latest", // request latest pending proposal
	PROPOSAL_APPROVE: "cmd:proposal-approve", // { filename } move to approved/
	RUN_SKILL: "cmd:run-skill", // { skillId, args? } dispatch a skill once (operator ground-truth probes)
	CONV_SAY: "cmd:conv-say", // { topic, text, intent?, position? } append turn to a multi-agent topic
	CONV_RECENT: "cmd:conv-recent", // { topic, n? } read last n turns
	CONV_LIST: "cmd:conv-list", // list active conversation topics
});

export function encodeFrame(obj) {
	return JSON.stringify(obj) + "\n";
}

// Stateful line splitter — instance per socket.
export function createLineParser(onObject) {
	let buf = "";
	return (chunk) => {
		buf += chunk.toString("utf8");
		let idx;
		while ((idx = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			try {
				onObject(JSON.parse(line));
			} catch (e) {
				onObject({ __parseError: true, raw: line, err: String(e) });
			}
		}
	};
}
