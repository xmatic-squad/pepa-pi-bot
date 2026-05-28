// Village Score (L5 eval) — one number for "is the bot actually building a
// settlement, or just walking?" (research §2). The research's formula mixes
// milestones, food stock, fence closure, lit tiles, uptime, distinct skills
// and dialog quality. We compute the subset that is *observable* today; fence
// polygon / lit-tile fraction stay at 0 until those skills exist (the score is
// honest about what it can measure rather than faking precision).
//
// Pure: snapshot + a few derived inputs in, { score, components } out. Score is
// normalised to 0..1 so a dashboard / TUI can show a single percentage.

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const DISTINCT_SKILL_TARGET = 12;

function clamp01(n) {
	if (!Number.isFinite(n)) return 0;
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

function milestoneFraction(contract) {
	if (!contract || !contract.total) return 0;
	return clamp01(contract.completed / contract.total);
}

function foodSecurity(snapshot) {
	if (snapshot?.hasFood) return 1;
	return clamp01((snapshot?.food ?? 0) / 18);
}

function baseEstablished(snapshot) {
	const loc = snapshot?.locations ?? {};
	const want = ["base", "shelter", "chest"];
	const have = want.filter((k) => loc[k]).length;
	return clamp01(have / want.length);
}

function distinctSkillsSucceeded(metrics) {
	if (!metrics) return 0;
	const n = Object.values(metrics).filter((m) => (m?.ok ?? 0) > 0).length;
	return clamp01(n / DISTINCT_SKILL_TARGET);
}

function uptimeFraction(uptimeMs) {
	return clamp01((uptimeMs ?? 0) / TWO_HOURS_MS);
}

function survival(snapshot) {
	return clamp01((snapshot?.health ?? 0) / 20);
}

const WEIGHTS = Object.freeze({
	milestones: 0.35,
	food: 0.15,
	base: 0.15,
	distinctSkills: 0.15,
	uptime: 0.10,
	survival: 0.10,
});

export function computeVillageScore(snapshot, { contract, uptimeMs = 0, metrics = null } = {}) {
	const components = {
		milestones: milestoneFraction(contract),
		food: foodSecurity(snapshot),
		base: baseEstablished(snapshot),
		distinctSkills: distinctSkillsSucceeded(metrics),
		uptime: uptimeFraction(uptimeMs),
		survival: survival(snapshot),
	};
	let score = 0;
	for (const [k, w] of Object.entries(WEIGHTS)) score += w * components[k];
	return {
		score: Math.round(clamp01(score) * 1000) / 1000,
		components,
		milestonesCompleted: contract?.completed ?? 0,
		milestonesTotal: contract?.total ?? 0,
	};
}

export const _internal = { clamp01, WEIGHTS, milestoneFraction, foodSecurity, baseEstablished };
