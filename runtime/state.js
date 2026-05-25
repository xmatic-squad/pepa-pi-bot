// Finite-state classifier for the runtime. Each tick the bot is in exactly
// one of:
//
//   emergency  — survival is at risk (low HP, hostile in melee, drowning…)
//   working    — an async action is in flight (reflexCtx.busy === true)
//   recovering — last action failed recently and we are in its cooldown
//   planning   — the LLM planner is computing a fresh plan.md
//   social     — we just produced a chat reply (cools down social activity)
//   idle       — none of the above; the bot is up but nothing is happening
//
// Pure function: takes the current observed inputs and returns a string.
// No side effects; the caller decides what to do with the classification.

export const STATES = Object.freeze({
	EMERGENCY: "emergency",
	WORKING: "working",
	RECOVERING: "recovering",
	PLANNING: "planning",
	SOCIAL: "social",
	IDLE: "idle",
});

const EMERGENCY_HP = 8;
const EMERGENCY_HOSTILE_DISTANCE = 4;
const RECOVERING_WINDOW_MS = 30_000;
const SOCIAL_WINDOW_MS = 5_000;

export function computeState({
	snapshot,
	ctx,
	plannerInFlight = false,
	lastChatReplyAt = 0,
	lastFailureAt = 0,
	now = Date.now(),
}) {
	if (!snapshot?.connected) return STATES.IDLE;

	const hp = snapshot.health ?? 20;
	if (hp <= EMERGENCY_HP) return STATES.EMERGENCY;
	if (snapshot.closestHostile && snapshot.closestHostile.distance <= EMERGENCY_HOSTILE_DISTANCE) {
		return STATES.EMERGENCY;
	}

	if (ctx?.busy) return STATES.WORKING;

	if (lastFailureAt && now - lastFailureAt < RECOVERING_WINDOW_MS) {
		return STATES.RECOVERING;
	}

	if (plannerInFlight) return STATES.PLANNING;

	if (lastChatReplyAt && now - lastChatReplyAt < SOCIAL_WINDOW_MS) {
		return STATES.SOCIAL;
	}

	return STATES.IDLE;
}
