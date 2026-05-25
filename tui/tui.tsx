/**
 * Ink-based TUI dashboard for the pepa runtime.
 *
 * Layout:
 *   ┌─────────── status (HP / food / pos / task / connection / paused) ──────────┐
 *   │ ┌───────── event log ─────────┐ ┌──────── MC chat ──────────┐              │
 *   │ │                             │ │                          │              │
 *   │ └─────────────────────────────┘ └──────────────────────────┘              │
 *   └─────────────────── command bar (hotkeys + chat input) ─────────────────────┘
 *
 * Hotkeys:
 *   p — pause / resume reflex loop
 *   s — stop bot (sends cmd:stop)
 *   r — request fresh snapshot
 *   c — enter chat mode (type, Enter to send to MC)
 *   a — enter ask-Pi mode (type, Enter to spawn pi -p)
 *   q — quit TUI (bot keeps running)
 */

import React, { useEffect, useReducer, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { createIpcClient } from "./ipc-client.js";
import { COMMAND_TYPES, EVENT_TYPES } from "../runtime/ipc-protocol.js";

type LogEntry = { ts: string; level: string; source: string; text: string };
type ChatEntry = { ts: string; from: string; text: string; kind: string };
type Snapshot = Record<string, any>;

type State = {
	connectedToBot: boolean;
	snapshot: Snapshot;
	logs: LogEntry[];
	chat: ChatEntry[];
	paused: boolean;
	piStream: string;
	piRunning: boolean;
	proposal: { filename: string | null; body: string | null; total: number } | null;
};

type Action =
	| { type: "ipc-connected" }
	| { type: "ipc-disconnected" }
	| { type: "snapshot"; payload: Snapshot }
	| { type: "log"; payload: LogEntry }
	| { type: "chat"; payload: { from: string; text: string; kind: string }; ts: string }
	| { type: "death"; payload: any; ts: string }
	| { type: "pi-chunk"; payload: { stream: string; text: string } }
	| { type: "pi-done"; payload: { code: number; durationMs: number } }
	| { type: "set-paused"; paused: boolean }
	| { type: "hello"; payload: { snapshot: Snapshot; recentLogs: LogEntry[] } }
	| { type: "proposal"; payload: { filename: string | null; body: string | null; total: number } }
	| { type: "proposal-close" };

const MAX_LOGS = 200;
const MAX_CHAT = 100;

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "ipc-connected":
			return { ...state, connectedToBot: true };
		case "ipc-disconnected":
			return { ...state, connectedToBot: false };
		case "snapshot":
			return { ...state, snapshot: action.payload || {} };
		case "log":
			return { ...state, logs: [...state.logs, action.payload].slice(-MAX_LOGS) };
		case "chat":
			return { ...state, chat: [...state.chat, { ts: action.ts, ...action.payload }].slice(-MAX_CHAT) };
		case "death":
			return {
				...state,
				logs: [
					...state.logs,
					{ ts: action.ts, level: "warn", source: "mc", text: `death at ${JSON.stringify(action.payload?.position ?? null)}` },
				].slice(-MAX_LOGS),
			};
		case "pi-chunk":
			return { ...state, piRunning: true, piStream: (state.piStream + action.payload.text).slice(-2000) };
		case "pi-done":
			return {
				...state,
				piRunning: false,
				piStream: state.piStream + `\n[pi done code=${action.payload.code} after ${action.payload.durationMs}ms]\n`,
			};
		case "set-paused":
			return { ...state, paused: action.paused };
		case "hello":
			return {
				...state,
				snapshot: action.payload.snapshot || {},
				logs: action.payload.recentLogs || [],
			};
		case "proposal":
			return { ...state, proposal: action.payload };
		case "proposal-close":
			return { ...state, proposal: null };
		default:
			return state;
	}
}

function StatusBar({ snapshot, paused, connectedToBot }: { snapshot: Snapshot; paused: boolean; connectedToBot: boolean }) {
	const tone = snapshot.connected ? "green" : "red";
	return (
		<Box borderStyle="round" borderColor={tone} flexDirection="column" paddingX={1}>
			<Text>
				<Text color={tone} bold>
					{snapshot.connected ? "● MC online" : "○ MC offline"}
				</Text>
				{"   "}
				<Text color={connectedToBot ? "green" : "red"}>{connectedToBot ? "IPC ok" : "IPC down"}</Text>
				{"   "}
				{paused ? <Text color="yellow">⏸ reflex paused</Text> : <Text color="green">▶ reflex live</Text>}
			</Text>
			<Text>
				user={snapshot.username ?? "?"} hp={snapshot.health ?? "?"} food={snapshot.food ?? "?"}{" "}
				pos=
				{snapshot.position
					? `${snapshot.position.x},${snapshot.position.y},${snapshot.position.z}`
					: "?"}{" "}
				day={String(snapshot.isDay ?? "?")} hostiles={snapshot.hostileCount ?? 0}
				{snapshot.closestHostile ? `  closest=${snapshot.closestHostile.name}@${snapshot.closestHostile.distance}m` : ""}
				{snapshot.pendingProposals ? <Text color="magenta" bold>{`  [proposals ${snapshot.pendingProposals}, press y]`}</Text> : null}
			</Text>
		</Box>
	);
}

function ProposalPanel({
	proposal,
	onClose,
	onApprove,
}: {
	proposal: { filename: string | null; body: string | null; total: number };
	onClose: () => void;
	onApprove: () => void;
}) {
	if (!proposal.filename) {
		return (
			<Box borderStyle="round" flexDirection="column" paddingX={1} borderColor="gray">
				<Text>No pending proposals. ([Esc] to close)</Text>
			</Box>
		);
	}
	const lines = (proposal.body ?? "").split("\n").slice(0, 30);
	return (
		<Box borderStyle="round" flexDirection="column" paddingX={1} borderColor="magenta">
			<Text bold color="magenta">
				proposal: {proposal.filename}  (total pending: {proposal.total})
			</Text>
			{lines.map((line, i) => (
				<Text key={i}>{line}</Text>
			))}
			<Text dimColor>[y]es approve  [n]o close  — uses npm run propose:apply afterwards</Text>
		</Box>
	);
}

function EventLog({ logs }: { logs: LogEntry[] }) {
	const last = logs.slice(-14);
	return (
		<Box borderStyle="round" flexDirection="column" paddingX={1} width="60%">
			<Text bold underline>
				events
			</Text>
			{last.map((l, i) => (
				<Text key={i} color={l.level === "warn" ? "yellow" : l.level === "error" ? "red" : "white"}>
					{l.ts.slice(11, 19)} [{l.source}] {l.text}
				</Text>
			))}
		</Box>
	);
}

function ChatPanel({ chat }: { chat: ChatEntry[] }) {
	const last = chat.slice(-14);
	return (
		<Box borderStyle="round" flexDirection="column" paddingX={1} width="40%">
			<Text bold underline>
				MC chat
			</Text>
			{last.map((c, i) => (
				<Text key={i} color={c.kind === "system" ? "gray" : "cyan"}>
					{c.ts?.slice(11, 19) ?? ""} {c.from}: {c.text}
				</Text>
			))}
		</Box>
	);
}

function PiPanel({ piStream, piRunning }: { piStream: string; piRunning: boolean }) {
	if (!piStream && !piRunning) return null;
	return (
		<Box borderStyle="round" flexDirection="column" paddingX={1} borderColor={piRunning ? "magenta" : "gray"}>
			<Text bold underline>
				pi (escalation) {piRunning ? "● running" : "○ idle"}
			</Text>
			<Text>{piStream || "(no output yet)"}</Text>
		</Box>
	);
}

type Mode = "idle" | "chat" | "ask-pi";

function App() {
	const { exit } = useApp();
	const [state, dispatch] = useReducer(reducer, {
		connectedToBot: false,
		snapshot: {},
		logs: [],
		chat: [],
		paused: false,
		piStream: "",
		piRunning: false,
		proposal: null,
	});

	const [client] = useState(() => createIpcClient());
	const [mode, setMode] = useState<Mode>("idle");
	const [inputValue, setInputValue] = useState("");

	useEffect(() => {
		const onConnected = () => dispatch({ type: "ipc-connected" });
		const onDisconnected = () => dispatch({ type: "ipc-disconnected" });
		const onFrame = (frame: any) => {
			switch (frame.type) {
				case EVENT_TYPES.STATUS:
					dispatch({ type: "snapshot", payload: frame.payload });
					break;
				case EVENT_TYPES.LOG:
					dispatch({ type: "log", payload: frame.payload });
					break;
				case EVENT_TYPES.CHAT:
					dispatch({ type: "chat", payload: frame.payload, ts: frame.ts });
					break;
				case EVENT_TYPES.DEATH:
					dispatch({ type: "death", payload: frame.payload, ts: frame.ts });
					break;
				case EVENT_TYPES.HELLO:
					dispatch({ type: "hello", payload: frame.payload });
					break;
				case EVENT_TYPES.ASK_PI_CHUNK:
					dispatch({ type: "pi-chunk", payload: frame.payload });
					break;
				case EVENT_TYPES.ASK_PI_DONE:
					dispatch({ type: "pi-done", payload: frame.payload });
					break;
				case EVENT_TYPES.PROPOSAL:
					dispatch({ type: "proposal", payload: frame.payload });
					break;
			}
		};
		(client as any).on("connected", onConnected);
		(client as any).on("disconnected", onDisconnected);
		(client as any).on("frame", onFrame);
		return () => {
			(client as any).off("connected", onConnected);
			(client as any).off("disconnected", onDisconnected);
			(client as any).off("frame", onFrame);
			client.close();
		};
	}, [client]);

	useInput((input, key) => {
		if (mode !== "idle") return; // text input has its own handling
		// Proposal panel is open — accept y/n only.
		if (state.proposal) {
			if (input === "y" && state.proposal.filename) {
				client.send(COMMAND_TYPES.PROPOSAL_APPROVE, { filename: state.proposal.filename });
				dispatch({ type: "proposal-close" });
			} else if (input === "n" || key.escape) {
				dispatch({ type: "proposal-close" });
			}
			return;
		}
		if (input === "q") {
			client.close();
			exit();
			return;
		}
		if (input === "p") {
			const next = !state.paused;
			client.send(next ? COMMAND_TYPES.PAUSE : COMMAND_TYPES.RESUME, {});
			dispatch({ type: "set-paused", paused: next });
		}
		if (input === "s") {
			client.send(COMMAND_TYPES.STOP, {});
		}
		if (input === "r") {
			client.send(COMMAND_TYPES.SNAPSHOT, {});
		}
		if (input === "c") setMode("chat");
		if (input === "a") setMode("ask-pi");
		if (input === "y") client.send(COMMAND_TYPES.PROPOSAL_LATEST, {});
	});

	function submit(value: string) {
		const text = value.trim();
		setInputValue("");
		const m = mode;
		setMode("idle");
		if (!text) return;
		if (m === "chat") client.send(COMMAND_TYPES.CHAT, { text });
		else if (m === "ask-pi") client.send(COMMAND_TYPES.ASK_PI, { prompt: text });
	}

	const hotkeyHint =
		mode === "idle"
			? "[p]ause/resume  [s]top  [r]efresh  [c]hat  [a]sk-pi  [y] proposals  [q]uit"
			: mode === "chat"
			? "chat → MC (Enter to send, Esc to cancel)"
			: "ask-pi → spawn pi -p (Enter to send)";

	return (
		<Box flexDirection="column">
			<StatusBar snapshot={state.snapshot} paused={state.paused} connectedToBot={state.connectedToBot} />
			<Box flexDirection="row">
				<EventLog logs={state.logs} />
				<ChatPanel chat={state.chat} />
			</Box>
			<PiPanel piStream={state.piStream} piRunning={state.piRunning} />
			{state.proposal ? (
				<ProposalPanel
					proposal={state.proposal}
					onClose={() => dispatch({ type: "proposal-close" })}
					onApprove={() => {
						if (state.proposal?.filename) {
							client.send(COMMAND_TYPES.PROPOSAL_APPROVE, { filename: state.proposal.filename });
							dispatch({ type: "proposal-close" });
						}
					}}
				/>
			) : null}
			<Box borderStyle="single" paddingX={1}>
				{mode === "idle" ? (
					<Text dimColor>{hotkeyHint}</Text>
				) : (
					<>
						<Text bold color={mode === "chat" ? "cyan" : "magenta"}>
							{mode === "chat" ? "chat> " : "pi> "}
						</Text>
						<TextInput
							value={inputValue}
							onChange={setInputValue}
							onSubmit={submit}
						/>
					</>
				)}
			</Box>
		</Box>
	);
}

render(<App />);
