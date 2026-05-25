// Lightweight reply generator. The bot's first line of social presence:
// short canned templates pulled from runtime state. Pi is intentionally
// *not* called from here — escalation to Pi for chat happens only when
// the bot is directly addressed AND no template fits, and that decision
// is made by the caller (bot.js), not here.

import { INTENTS } from "./intent.js";

const GREETINGS = ["yo", "hey", "hi", "привет", "здаров", "salut"];

function pick(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

function describeBusy(snapshot) {
	const skill = snapshot?.busy?.label ?? snapshot?.activeSkill;
	if (skill) return `working on ${skill}`;
	const milestone = snapshot?.currentMilestone;
	if (milestone) return `working toward "${milestone}"`;
	if (snapshot?.runtimeState && snapshot.runtimeState !== "idle") {
		return `state=${snapshot.runtimeState}`;
	}
	return "just observing";
}

function describeStats(snapshot) {
	const parts = [];
	if (snapshot?.health !== undefined) parts.push(`hp=${snapshot.health}/20`);
	if (snapshot?.food !== undefined) parts.push(`food=${snapshot.food}/20`);
	if (snapshot?.position) parts.push(`@${snapshot.position.x},${snapshot.position.z}`);
	return parts.join(" ");
}

function statusReply({ speaker, snapshot, diaryTail }) {
	const stats = describeStats(snapshot);
	const busy = describeBusy(snapshot);
	const reason = snapshot?.noProgressReason ? ` (blocker: ${snapshot.noProgressReason})` : "";
	const diary = diaryTail ? ` — last note: ${diaryTail.slice(0, 80)}` : "";
	return `${speaker}: ${busy}. ${stats}${reason}${diary}`;
}

// generateReply returns:
//   { send: string }      — a chat line to send now
//   { send: null }        — say nothing (caller still records the chat)
//   { send: null, escalate: true } — caller may escalate to Pi (only if
//                                    the bot was directly addressed)
export function generateReply({ intent, speaker, snapshot, diaryTail }) {
	if (intent === INTENTS.COMMAND_LIKE) {
		// Caller (bot.js) replies with the dialog-only notice and records
		// the ignored command — we don't take that responsibility here.
		return { send: null, recordIgnored: true };
	}
	if (intent === INTENTS.UNSAFE_REQUEST) {
		// Likewise — escalation log is bot.js's job.
		return { send: null, recordEscalation: true };
	}
	if (intent === INTENTS.GREETING) {
		return { send: `${speaker}: ${pick(GREETINGS)}` };
	}
	if (intent === INTENTS.STATUS_QUESTION) {
		return { send: statusReply({ speaker, snapshot, diaryTail }) };
	}
	if (intent === INTENTS.ADDRESSED_BANTER) {
		// Templates can't reliably answer arbitrary addressed chat; flag for
		// possible Pi escalation. bot.js decides whether to actually spend
		// tokens — rate-limits there.
		return { send: null, escalate: true };
	}
	return { send: null };
}
