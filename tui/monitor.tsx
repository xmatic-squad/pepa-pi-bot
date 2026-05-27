/**
 * pepa monitor — fullscreen, read-only TUI.
 *
 * Replaces the old action-heavy tui/tui.tsx with a pure observability
 * dashboard inspired by opencode's full-screen layout. No hotkeys to
 * dispatch skills / send chat / approve proposals — operator does that
 * via scripts/* or by writing to the IPC sock directly. This screen
 * just shows what the bot is doing, in colour.
 *
 * Panels (top → bottom):
 *   1. Header        — connection / position / hp / food / time
 *   2. Storyline     — current step + the 11-step quest map
 *   3. Activity      — last N dispatches (colour-coded by outcome)
 *      + MC chat     — last N lines
 *   4. Advisor       — last 6 LLM recommendations (trigger / outcome / tokens)
 *      + Improvements — open queue from improvement_requests
 *   5. Footer        — token usage today, advisor stats, q to quit
 *
 * Live data sources:
 *   - IPC sock (snapshot frames, log frames, chat frames)
 *   - SQLite (knowledge.db) polled every 5s for advisor + improvements
 */

import React, { useEffect, useReducer, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import { createIpcClient } from "./ipc-client.js";
import { EVENT_TYPES } from "../runtime/ipc-protocol.js";
import { stateDir } from "../runtime/config.js";
import { initKnowledge, isAvailable as knowledgeReady, recentRecommendations, listImprovements, recommendationStats } from "../runtime/knowledge/index.js";

// --- types ------------------------------------------------------------------

type LogEntry = { ts: string; level: string; source: string; text: string };
type ChatEntry = { uid: number; ts: string; from: string; text: string; kind: string };
type Snapshot = Record<string, any>;
type Dispatch = { uid: number; ts: number; kind: "start" | "end"; label: string; ok?: boolean; code?: string; detail?: string };

let _uidSeq = 0;
function nextUid() { _uidSeq += 1; return _uidSeq; }

type State = {
	connectedIpc: boolean;
	snapshot: Snapshot;
	logs: LogEntry[];
	chat: ChatEntry[];
	dispatches: Dispatch[];
	startedAt: number;
};

type Action =
	| { type: "ipc-connected" }
	| { type: "ipc-disconnected" }
	| { type: "snapshot"; payload: Snapshot }
	| { type: "log"; payload: LogEntry }
	| { type: "chat"; payload: { from: string; text: string; kind: string }; ts: string };

const MAX_LOGS = 200;
const MAX_CHAT = 50;
const MAX_DISPATCHES = 30;

// --- reducer ----------------------------------------------------------------

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "ipc-connected":
			return { ...state, connectedIpc: true };
		case "ipc-disconnected":
			return { ...state, connectedIpc: false };
		case "snapshot":
			return { ...state, snapshot: action.payload };
		case "log": {
			const logs = [...state.logs, action.payload].slice(-MAX_LOGS);
			// also derive a dispatches view: lines like "→ label" or "← label ok/fail (...)"
			const dispatches = extractDispatch(state.dispatches, action.payload);
			return { ...state, logs, dispatches };
		}
		case "chat": {
			const chat = [...state.chat, { uid: nextUid(), ts: action.ts, ...action.payload }].slice(-MAX_CHAT);
			return { ...state, chat };
		}
		default:
			return state;
	}
}

function extractDispatch(prev: Dispatch[], log: LogEntry): Dispatch[] {
	if (log.source !== "dispatch") return prev;
	const ts = Date.parse(log.ts) || Date.now();
	// "→ label" — skill starting
	const startMatch = /^→\s+(\S+)/.exec(log.text);
	if (startMatch) {
		return [...prev, { uid: nextUid(), ts, kind: "start", label: startMatch[1] }].slice(-MAX_DISPATCHES);
	}
	// "← label ok/fail (...)" — skill ending
	const endMatch = /^←\s+(\S+)\s+(ok|fail)(?:\s+\((.*)\))?/.exec(log.text);
	if (endMatch) {
		const [, label, outcome, detail] = endMatch;
		return [...prev, { uid: nextUid(), ts, kind: "end", label, ok: outcome === "ok", detail }].slice(-MAX_DISPATCHES);
	}
	return prev;
}

// --- helpers ----------------------------------------------------------------

function formatAge(ts: number) {
	const dt = Math.max(0, Date.now() - ts);
	if (dt < 60_000) return `${Math.floor(dt / 1000)}s`;
	if (dt < 3600_000) return `${Math.floor(dt / 60_000)}m`;
	const h = Math.floor(dt / 3600_000);
	const m = Math.floor((dt % 3600_000) / 60_000);
	return `${h}h${m}m`;
}

function formatDuration(ms: number) {
	const s = Math.floor(ms / 1000) % 60;
	const m = Math.floor(ms / 60_000) % 60;
	const h = Math.floor(ms / 3600_000);
	if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
	if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
	return `${s}s`;
}

function shortTime(ts: number) {
	const d = new Date(ts);
	return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

function hpColor(hp: number | undefined) {
	if (hp == null) return "gray";
	if (hp <= 5) return "red";
	if (hp <= 12) return "yellow";
	return "green";
}
function foodColor(food: number | undefined) {
	if (food == null) return "gray";
	if (food <= 4) return "red";
	if (food <= 10) return "yellow";
	return "green";
}

// --- components -------------------------------------------------------------

function Header({ snapshot, connectedIpc, width, startedAt }: { snapshot: Snapshot; connectedIpc: boolean; width: number; startedAt: number }) {
	const pos = snapshot.position
		? `(${Math.round(snapshot.position.x)}, ${Math.round(snapshot.position.y)}, ${Math.round(snapshot.position.z)})`
		: "?";
	const hp = snapshot.health;
	const food = snapshot.food;
	const day = snapshot.isDay ? "☀ day" : "🌙 night";
	const session = formatDuration(Date.now() - startedAt);
	const mcOnline = snapshot.connected;
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
			<Box>
				<Text bold color="cyan">pepa-monitor</Text>
				<Text dimColor>  ·  </Text>
				<Text color={mcOnline ? "green" : "red"}>{mcOnline ? "● MC" : "○ MC"}</Text>
				<Text dimColor>  ·  </Text>
				<Text color={connectedIpc ? "green" : "red"}>{connectedIpc ? "● IPC" : "○ IPC"}</Text>
				<Text dimColor>  ·  </Text>
				<Text>session {session}</Text>
				<Text dimColor>  ·  </Text>
				<Text>user </Text><Text bold>{snapshot.username ?? "?"}</Text>
			</Box>
			<Box>
				<Text>pos </Text><Text bold>{pos}</Text>
				<Text dimColor>   </Text>
				<Text>HP </Text>
				<Text bold color={hpColor(hp)}>{hp ?? "?"}/20</Text>
				<Text dimColor>   </Text>
				<Text>food </Text>
				<Text bold color={foodColor(food)}>{food ?? "?"}/20</Text>
				<Text dimColor>   </Text>
				<Text>{day}</Text>
				<Text dimColor>   hostiles </Text>
				<Text color={(snapshot.hostileCount ?? 0) > 0 ? "red" : "gray"}>{snapshot.hostileCount ?? 0}</Text>
				{snapshot.closestHostile ? <Text color="red">  closest {snapshot.closestHostile.name}@{snapshot.closestHostile.distance}b</Text> : null}
			</Box>
		</Box>
	);
}

function StorylinePanel({ snapshot, width }: { snapshot: Snapshot; width: number }) {
	const story = snapshot.storyStep;
	if (!story) {
		return (
			<Box borderStyle="round" borderColor="gray" paddingX={1} width={width}>
				<Text dimColor>storyline not available (bot offline or storyline disabled)</Text>
			</Box>
		);
	}
	const STEPS = [
		"orient_self", "first_wood", "crafting_basics", "first_tools", "first_food",
		"shelter_minimal", "stone_tier", "food_security", "iron_age", "settle_base", "village_grow",
	];
	const TITLES: Record<string, string> = {
		orient_self: "Понять где я",
		first_wood: "Собрать 8 поленьев",
		crafting_basics: "Сделать верстак и палки",
		first_tools: "Деревянные орудия",
		first_food: "Найти первую еду",
		shelter_minimal: "Простой шелтер с кроватью",
		stone_tier: "Каменные орудия",
		food_security: "Запас еды на 16+",
		iron_age: "Железо и печь",
		settle_base: "Постоянная база",
		village_grow: "Развивать деревню",
	};
	const idx = story.index ?? 0;
	const cur = story.step;
	const want = story.suggestion?.skillId;
	const emergency = story.emergency;
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} width={width}>
			<Box>
				<Text bold color="magenta">storyline</Text>
				<Text dimColor>   step </Text>
				<Text bold>{idx + 1}/11</Text>
				<Text dimColor>   </Text>
				<Text bold color="white">{cur?.id}</Text>
				<Text dimColor>   {cur?.title}</Text>
				{emergency ? <Text color="red" bold>   [EMERGENCY PAUSE]</Text> : null}
			</Box>
			{want ? (
				<Box>
					<Text dimColor>wants: </Text>
					<Text color="cyan">{want}</Text>
				</Box>
			) : null}
			<Box flexDirection="column" marginTop={1}>
				{STEPS.map((id, i) => {
					const done = i < idx;
					const current = i === idx;
					const mark = done ? "✓" : current ? "→" : "○";
					const color = done ? "green" : current ? "yellow" : "gray";
					return (
						<Text key={id} color={color}>
							{`  ${mark} ${(i + 1).toString().padStart(2)}. ${id.padEnd(18)} ${TITLES[id] ?? ""}`}
						</Text>
					);
				})}
			</Box>
		</Box>
	);
}

function ActivityPanel({ dispatches, width, height }: { dispatches: Dispatch[]; width: number; height: number }) {
	const visible = dispatches.slice(-height);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} width={width}>
			<Text bold color="blue">Activity (last {visible.length})</Text>
			{visible.map((d) => {
				if (d.kind === "start") {
					return (
						<Text key={d.uid} dimColor>
							{shortTime(d.ts)} → <Text color="white">{d.label}</Text>
						</Text>
					);
				}
				const color = d.ok ? "green" : "red";
				const tail = d.detail ? ` (${String(d.detail).slice(0, 30)})` : "";
				return (
					<Text key={d.uid}>
						<Text dimColor>{shortTime(d.ts)} </Text>
						<Text color={color}>← {d.label} {d.ok ? "ok" : "fail"}</Text>
						<Text dimColor>{tail}</Text>
					</Text>
				);
			})}
			{visible.length === 0 ? <Text dimColor>(waiting for activity…)</Text> : null}
		</Box>
	);
}

function ChatPanel({ chat, width, height }: { chat: ChatEntry[]; width: number; height: number }) {
	const visible = chat.slice(-height);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} width={width}>
			<Text bold color="green">MC Chat (last {visible.length})</Text>
			{visible.map((c) => (
				<Text key={c.uid}>
					<Text dimColor>{c.ts?.slice(11, 16) ?? ""} </Text>
					<Text color={c.kind === "system" ? "gray" : c.from === "pepa_bot" ? "cyan" : "yellow"} bold={c.from !== "pepa_bot" && c.kind !== "system"}>
						{c.from}:
					</Text>
					<Text> {c.text.slice(0, width - 12)}</Text>
				</Text>
			))}
			{visible.length === 0 ? <Text dimColor>(no chat yet…)</Text> : null}
		</Box>
	);
}

function AdvisorPanel({ recs, width, height }: { recs: any[]; width: number; height: number }) {
	const visible = recs.slice(0, height);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={width}>
			<Text bold color="yellow">Advisor (last {visible.length})</Text>
			{visible.map((r) => {
				const ok = r.outcome_ok;
				const outcomeMark = ok == null ? "·" : ok ? "✓" : "✗";
				const outcomeColor = ok == null ? "gray" : ok ? "green" : "red";
				const tail = `${r.tokens_in ?? "?"}/${r.tokens_out ?? "?"}t  ${r.latency_ms ?? "?"}ms`;
				return (
					<Box key={`adv-${r.id}`} flexDirection="column">
						<Text>
							<Text color={outcomeColor} bold>{outcomeMark} </Text>
							<Text color="white">{r.trigger_reason}</Text>
							<Text dimColor> → </Text>
							<Text color="cyan">{r.recommended_skill ?? r.action}</Text>
						</Text>
						<Text dimColor>    {tail}{r.rationale ? ` · ${String(r.rationale).slice(0, width - 14)}` : ""}</Text>
					</Box>
				);
			})}
			{visible.length === 0 ? <Text dimColor>(no advisor calls yet)</Text> : null}
		</Box>
	);
}

function ImprovementsPanel({ items, width, height }: { items: any[]; width: number; height: number }) {
	const visible = items.slice(0, height);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} width={width}>
			<Text bold color="magenta">Improvements (open: {items.length})</Text>
			{visible.map((r) => (
				<Box key={`imp-${r.id}`} flexDirection="column">
					<Text>
						<Text color="gray">#{r.id} </Text>
						<Text color="yellow">P{r.priority}</Text>
						<Text dimColor> ×{r.votes} </Text>
						<Text color="white">{String(r.title).slice(0, width - 14)}</Text>
					</Text>
					{r.description ? (
						<Text dimColor>    {String(r.description).slice(0, width - 8)}</Text>
					) : null}
				</Box>
			))}
			{visible.length === 0 ? <Text dimColor>(no improvement requests yet)</Text> : null}
		</Box>
	);
}

function Footer({ stats, width }: { stats: any[]; width: number }) {
	const total = stats.reduce(
		(acc, s) => ({
			calls: acc.calls + (s.total ?? 0),
			succ: acc.succ + (s.succeeded ?? 0),
			fail: acc.fail + (s.failed ?? 0),
			in: acc.in + (s.avg_in ?? 0) * (s.total ?? 0),
			out: acc.out + (s.avg_out ?? 0) * (s.total ?? 0),
		}),
		{ calls: 0, succ: 0, fail: 0, in: 0, out: 0 },
	);
	const priceInRub = Number(process.env.TIMEWEB_PRICE_IN_RUB_PER_M) || 101;
	const priceOutRub = Number(process.env.TIMEWEB_PRICE_OUT_RUB_PER_M) || 608;
	const costRub = (total.in * priceInRub + total.out * priceOutRub) / 1_000_000;
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={width}>
			<Box>
				<Text dimColor>Last 24h: </Text>
				<Text bold>{total.calls}</Text>
				<Text dimColor> advisor calls (</Text>
				<Text color="green">{total.succ} ok</Text>
				<Text dimColor> / </Text>
				<Text color="red">{total.fail} fail</Text>
				<Text dimColor>)   tokens </Text>
				<Text bold>{Math.round(total.in / 1000)}K</Text>
				<Text dimColor> in / </Text>
				<Text bold>{Math.round(total.out / 1000)}K</Text>
				<Text dimColor> out   ≈ </Text>
				<Text bold color="cyan">{costRub.toFixed(2)} ₽</Text>
			</Box>
			<Box>
				<Text dimColor>q — quit (bot keeps running)</Text>
			</Box>
		</Box>
	);
}

// --- main app ---------------------------------------------------------------

function App() {
	const { exit } = useApp();
	const { stdout } = useStdout();
	// Sample stdout dimensions periodically. Subscribing directly to
	// stdout.on('resize') from a React hook conflicts with ink's own
	// listener and produces "MaxListenersExceededWarning" / reconciler
	// errors. A 1s poll is cheap and good enough — terminals don't
	// resize often.
	const [cols, setCols] = useState<number>((stdout as any)?.columns ?? 120);
	const [rows, setRows] = useState<number>((stdout as any)?.rows ?? 30);
	useEffect(() => {
		const t = setInterval(() => {
			setCols((stdout as any)?.columns ?? 120);
			setRows((stdout as any)?.rows ?? 30);
		}, 1000);
		return () => clearInterval(t);
	}, [stdout]);

	const [state, dispatch] = useReducer(reducer, {
		connectedIpc: false,
		snapshot: {},
		logs: [],
		chat: [],
		dispatches: [],
		startedAt: Date.now(),
	});

	const [client] = useState(() => createIpcClient());
	const [knowledgeOk, setKnowledgeOk] = useState(false);
	const [recs, setRecs] = useState<any[]>([]);
	const [improvements, setImprovements] = useState<any[]>([]);
	const [stats, setStats] = useState<any[]>([]);

	// IPC
	useEffect(() => {
		const onConnected = () => dispatch({ type: "ipc-connected" });
		const onDisconnected = () => dispatch({ type: "ipc-disconnected" });
		const onFrame = (frame: any) => {
			switch (frame.type) {
				case EVENT_TYPES.STATUS: dispatch({ type: "snapshot", payload: frame.payload }); break;
				case EVENT_TYPES.LOG: dispatch({ type: "log", payload: frame.payload }); break;
				case EVENT_TYPES.CHAT: dispatch({ type: "chat", payload: frame.payload, ts: frame.ts }); break;
				case EVENT_TYPES.HELLO:
					if (frame.payload?.snapshot) dispatch({ type: "snapshot", payload: frame.payload.snapshot });
					if (frame.payload?.recentLogs) {
						for (const lg of frame.payload.recentLogs) dispatch({ type: "log", payload: lg });
					}
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

	// Knowledge DB init + polling
	useEffect(() => {
		let mounted = true;
		(async () => {
			try {
				await initKnowledge({ stateDir });
				if (!mounted) return;
				setKnowledgeOk(knowledgeReady());
			} catch {}
		})();
		const poll = () => {
			if (!knowledgeReady()) return;
			try {
				setRecs(recentRecommendations({ limit: 12 }));
				setImprovements(listImprovements({ status: "open", limit: 12 }));
				setStats(recommendationStats({ sinceHours: 24 }));
			} catch {}
		};
		poll();
		const t = setInterval(poll, 5000);
		return () => { mounted = false; clearInterval(t); };
	}, [knowledgeOk]);

	// useInput requires TTY raw mode; skip it when stdin isn't a TTY
	// (e.g. when piped during a smoke test). Real `npm run tui` is always TTY.
	const isTty = !!process.stdin.isTTY;
	if (isTty) {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		useInput((input, key) => {
			if (input === "q" || (key.ctrl && input === "c") || key.escape) {
				client.close();
				exit();
			}
		});
	}

	// Layout math: full-width header & storyline, then split 50/50.
	const totalWidth = Math.max(80, cols);
	const halfWidth = Math.floor(totalWidth / 2);
	const totalRows = Math.max(24, rows);
	// rough allocation: header 4, storyline ~14, footer 4. Rest split for middle panels.
	const middleRows = Math.max(8, Math.floor((totalRows - 4 - 14 - 4) / 2));

	return (
		<Box flexDirection="column" width={totalWidth}>
			<Header snapshot={state.snapshot} connectedIpc={state.connectedIpc} width={totalWidth} startedAt={state.startedAt} />
			<StorylinePanel snapshot={state.snapshot} width={totalWidth} />
			<Box flexDirection="row" width={totalWidth}>
				<ActivityPanel dispatches={state.dispatches} width={halfWidth} height={middleRows} />
				<ChatPanel chat={state.chat} width={totalWidth - halfWidth} height={middleRows} />
			</Box>
			<Box flexDirection="row" width={totalWidth}>
				<AdvisorPanel recs={recs} width={halfWidth} height={middleRows} />
				<ImprovementsPanel items={improvements} width={totalWidth - halfWidth} height={middleRows} />
			</Box>
			<Footer stats={stats} width={totalWidth} />
		</Box>
	);
}

// --- entrypoint -------------------------------------------------------------

// Use the alternate screen buffer so the dashboard owns the entire viewport
// and the operator's prior terminal contents come back after quit.
// Skip when stdout isn't a TTY (e.g. piped output during smoke tests).
const useAltScreen = !!process.stdout.isTTY && process.env.PEPA_TUI_NO_ALT !== "1";
if (useAltScreen) {
	process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
	const onExit = () => process.stdout.write("\x1b[?1049l");
	process.on("exit", onExit);
	process.on("SIGINT", () => { onExit(); process.exit(0); });
	process.on("SIGTERM", () => { onExit(); process.exit(0); });
}

render(<App />);
