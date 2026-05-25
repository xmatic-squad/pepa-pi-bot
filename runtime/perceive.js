// Build a compact, JSON-safe snapshot of the world around the bot. Used both
// for reflex decisions and for periodic IPC STATUS events.

function vec3ToObj(v) {
	if (!v) return null;
	return { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(v.z * 100) / 100 };
}

const HOSTILE = new Set([
	"zombie",
	"skeleton",
	"creeper",
	"spider",
	"witch",
	"pillager",
	"vindicator",
	"husk",
	"stray",
	"drowned",
	"phantom",
	"enderman",
	"slime",
	"magma_cube",
	"hoglin",
	"piglin_brute",
	"ravager",
	"warden",
	"breeze",
	"bogged",
]);

export function snapshot(bot) {
	if (!bot || !bot.entity) {
		return { connected: false };
	}
	const pos = bot.entity.position;
	const entities = Object.values(bot.entities || {});
	const players = entities.filter((e) => e.type === "player" && e.username && e.username !== bot.username);
	const hostiles = entities.filter((e) => HOSTILE.has((e.name || "").toLowerCase()));
	const closestHostile = hostiles.reduce((best, e) => {
		const d = e.position.distanceTo(pos);
		return !best || d < best.d ? { d, e } : best;
	}, null);

	const inventory = (bot.inventory?.items?.() ?? []).reduce((acc, item) => {
		acc[item.name] = (acc[item.name] ?? 0) + item.count;
		return acc;
	}, {});

	return {
		connected: true,
		username: bot.username,
		position: vec3ToObj(pos),
		health: bot.health,
		food: bot.food,
		saturation: bot.foodSaturation,
		experience: bot.experience?.level,
		time: bot.time?.timeOfDay,
		isDay: bot.time?.isDay,
		weather: { rain: bot.isRaining, thunder: bot.thundering },
		dimension: bot.game?.dimension,
		inventory,
		players: players.map((p) => ({ name: p.username, distance: Math.round(p.position.distanceTo(pos)) })),
		hostileCount: hostiles.length,
		closestHostile: closestHostile
			? { name: closestHostile.e.name, distance: Math.round(closestHostile.d * 10) / 10 }
			: null,
	};
}
