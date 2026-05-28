// Persona chatter — bot occasionally narrates its life in Russian chat.
//
// Goal: feel like a player, not a script. The bot announces when it
// starts a major skill, when it spots danger, when it respawns, when
// it accomplishes a milestone. All lines are Russian, ≤ 80 chars, sent
// via bot.chat().
//
// Hard rate limits (so it's not annoying):
//   - min 75 seconds between any two narrations
//   - max 8 narrations / hour
//   - duplicate-line suppression (don't repeat the same template-line
//     twice in a row)
//
// Design: poll-based. We attach a 5-second timer that compares the
// current snapshot to the last seen one and fires narration on
// transitions. No invasive hooks into runSkill / reflex; the existing
// snapshot pipeline gives us everything.

import { info, warn } from "../log.js";

const POLL_INTERVAL_MS = 5_000;
const MIN_GAP_MS = 75_000;
const MAX_PER_HOUR = 8;

// Templates by event. Pick one at random.
const TEMPLATES = {
	respawn: [
		"уф, опять смерть. поднимаюсь, иду дальше.",
		"снова на ногах. ладно, продолжаем.",
		"перерождение. что было — то прошло.",
		"ох, опять. ладно, поехали.",
	],
	gather_logs_start: [
		"пошёл за деревом",
		"надо дровишек нарубить",
		"иду рубить лес",
		"за дровами",
	],
	gather_stone_start: [
		"за камнем",
		"надо камешка добыть",
		"копаю стоунушку",
	],
	craft_start: [
		"крафтю",
		"за верстаком",
	],
	build_start: [
		"строю что-то небольшое",
		"немного строительства",
	],
	travel_start: [
		"иду осваиваться дальше",
		"в путь",
		"посмотрю что там вокруг",
	],
	threat_creeper: [
		"крепер рядом, аккуратнее",
		"тссс... крепер",
		"крепер... убегаю",
	],
	threat_skeleton: [
		"скелет с луком, прячусь",
		"скелет, надо в укрытие",
	],
	threat_zombie: [
		"зомби идёт",
		"зомби, готовлюсь",
	],
	night_approaching: [
		"скоро темно. где бы укрыться",
		"ночь близко. надо в безопасное место",
		"темнеет",
	],
	day_break: [
		"светает. дышу свободнее",
		"утро. опасности меньше",
	],
	milestone_done: [
		"ура, готово",
		"одно дело сделано",
	],
	stuck: [
		"что-то застрял. думаю",
		"попал в неудобное место",
	],
};

let _state = null;
let _timer = null;
let _last = {
	activeSkill: null,
	runtimeState: null,
	threatHostile: null,
	dayPart: null,
	noProgressReason: null,
	storyStepId: null,
};
let _lastNarrationAt = 0;
let _narrationTimes = [];
let _lastTemplate = null;

export function attach(bot, ctx = {}) {
	if (_timer) {
		warn("persona", "attach() already called");
		return;
	}
	if (!bot) return;
	_state = { bot, ctx };

	bot.on?.("respawn", () => maybeNarrate("respawn"));
	// On 'death' event we DON'T narrate (we're dead, no chat). Narration
	// happens on respawn.

	_timer = setInterval(() => {
		try { tick(); } catch (e) { warn("persona", `tick err: ${e?.message ?? e}`); }
	}, POLL_INTERVAL_MS);
	_timer.unref?.();
	info("persona", `chatter attached (poll ${POLL_INTERVAL_MS / 1000}s, max ${MAX_PER_HOUR}/h)`);
}

export function detach() {
	if (_timer) { clearInterval(_timer); _timer = null; }
	_state = null;
	_last = { activeSkill: null, runtimeState: null, threatHostile: null, dayPart: null, noProgressReason: null };
}

function tick() {
	if (!_state) return;
	const snap = _state.ctx?.getSnapshot?.();
	if (!snap) return;

	// 1. Skill transition
	const skill = snap.activeSkill ?? null;
	if (skill && skill !== _last.activeSkill) {
		const key = skillTemplateKey(skill);
		if (key) maybeNarrate(key);
		_last.activeSkill = skill;
	}

	// 2. Threat appearance
	const hostile = snap.closestHostile?.name ?? snap.threats?.[0]?.name ?? null;
	const hostileClose = snap.closestHostile?.distance && snap.closestHostile.distance < 12;
	if (hostile && hostile !== _last.threatHostile && hostileClose) {
		const tk = `threat_${hostile}`;
		if (TEMPLATES[tk]) maybeNarrate(tk);
		_last.threatHostile = hostile;
	} else if (!hostile) {
		_last.threatHostile = null;
	}

	// 3. Day/night transition
	const dayPart = inferDayPart(snap);
	if (dayPart && dayPart !== _last.dayPart) {
		if (dayPart === "dusk") maybeNarrate("night_approaching");
		else if (dayPart === "dawn") maybeNarrate("day_break");
		_last.dayPart = dayPart;
	}

	// 4. Stuck signal
	if (snap.noProgressReason && snap.noProgressReason !== _last.noProgressReason) {
		if (["no_reachable_target", "awaiting_action_cooldown", "planner_empty"].includes(snap.noProgressReason)) {
			maybeNarrate("stuck");
		}
		_last.noProgressReason = snap.noProgressReason;
	}

	// 4b. Storyline step transition — narrate the *narration_ru* line
	// straight from runtime/goal/storyline.js when the step changes.
	// This is the bot speaking about its current quest concretely.
	const story = snap.storyStep ?? null;
	if (story?.step?.id && story.step.id !== _last.storyStepId && story.step.narration_ru) {
		maybeNarrateRaw(story.step.narration_ru);
		_last.storyStepId = story.step.id;
	}

	// 5. Milestone done — fires when activeSkill flips to noop and lastResult.ok
	const last = snap.lastResult;
	if (last?.ok && last?.code === "done") {
		const k = milestoneKey(last.label);
		if (k) maybeNarrate(k);
	}
}

function skillTemplateKey(label) {
	if (!label) return null;
	if (label.startsWith("gather.logs")) return "gather_logs_start";
	if (label.startsWith("gather.stone")) return "gather_stone_start";
	if (label.startsWith("craft.")) return "craft_start";
	if (label.startsWith("village.build") || label.startsWith("village.place")) return "build_start";
	if (label.startsWith("explore.") || label.startsWith("wander")) return "travel_start";
	return null;
}

function milestoneKey(label) {
	if (!label) return null;
	if (label.startsWith("craft.") || label.startsWith("village.place-chest") || label.startsWith("village.build-shelter")) {
		return "milestone_done";
	}
	return null;
}

function inferDayPart(snap) {
	const t = snap.timeOfDay ?? snap.time?.timeOfDay;
	if (typeof t !== "number") return null;
	// Minecraft day: 0..24000. 0 sunrise, 6000 noon, 12000 sunset, 18000 midnight.
	if (t > 12000 && t < 13800) return "dusk";
	if (t > 22500 || t < 1500) return "dawn";
	return null;
}

function maybeNarrate(key) {
	const line = pickLine(key);
	if (!line) return;
	maybeNarrateRaw(line);
}

function maybeNarrateRaw(line) {
	if (!line) return;
	const now = Date.now();
	const hourAgo = now - 3600_000;
	_narrationTimes = _narrationTimes.filter((t) => t > hourAgo);
	if (now - _lastNarrationAt < MIN_GAP_MS) return;
	if (_narrationTimes.length >= MAX_PER_HOUR) return;
	if (line === _lastTemplate) return;
	const ok = sendChat(line);
	if (ok) {
		_lastNarrationAt = now;
		_narrationTimes.push(now);
		_lastTemplate = line;
	}
}

function pickLine(key) {
	const pool = TEMPLATES[key] ?? [];
	if (pool.length === 0) return null;
	if (pool.length === 1) return pool[0];
	// Avoid the same line twice in a row.
	let candidates = pool.filter((l) => l !== _lastTemplate);
	if (candidates.length === 0) candidates = pool;
	const i = Math.floor(Math.random() * candidates.length);
	return candidates[i];
}

function sendChat(text) {
	if (!_state?.bot?.chat) return false;
	try {
		_state.bot.chat(text);
		info("persona", `narrated: ${text}`);
		return true;
	} catch (e) {
		warn("persona", `chat send failed: ${e?.message ?? e}`);
		return false;
	}
}

// Test exports
export const __testing = {
	TEMPLATES,
	resetState() {
		_lastNarrationAt = 0;
		_narrationTimes = [];
		_lastTemplate = null;
		_last = { activeSkill: null, runtimeState: null, threatHostile: null, dayPart: null, noProgressReason: null };
	},
	inferDayPart,
	skillTemplateKey,
	tick,
	setState(s) { _state = s; },
	getState() { return _state; },
	maybeNarrate,
};
