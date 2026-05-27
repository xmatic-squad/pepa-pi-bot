// village.place-chest — place the carried chest near the base/current
// footing and register it as "chest" in locations.json. This turns the
// storage milestone from "I crafted a chest item" into "I have a usable
// storage location".

import { setLocation, getLocation } from "../locations.js";

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function carriedChest(bot) {
	return bot.inventory.items().find((i) => i.name === "chest" || i.name === "trapped_chest");
}

function isEmpty(block) {
	return !block || block.boundingBox === "empty" || block.name === "air" || block.name === "cave_air" || block.name === "void_air";
}

function placementCandidate(bot) {
	const here = bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position;
	const offsets = [
		{ x: 1, z: 0 },
		{ x: -1, z: 0 },
		{ x: 0, z: 1 },
		{ x: 0, z: -1 },
		{ x: 2, z: 0 },
		{ x: 0, z: 2 },
	];
	for (const off of offsets) {
		const ref = bot.blockAt({ x: Math.round(here.x + off.x), y: Math.round(here.y - 1), z: Math.round(here.z + off.z) });
		const target = bot.blockAt({ x: Math.round(here.x + off.x), y: Math.round(here.y), z: Math.round(here.z + off.z) });
		if (ref?.boundingBox === "block" && isEmpty(target)) {
			return { ref, face: { x: 0, y: 1, z: 0 }, at: { x: ref.position.x, y: ref.position.y + 1, z: ref.position.z } };
		}
	}
	return null;
}

export const skill = Object.freeze({
	id: "village.place-chest",
	title: "Place a personal chest",
	timeoutMs: 30_000,
	preconditions(ctx) {
		if (!ctx?.bot) return { ok: false, code: "no_bot", detail: "bot missing" };
		if (getLocation("chest")) return { ok: false, code: "already_have", detail: "chest location already exists" };
		if (!carriedChest(ctx.bot)) return { ok: false, code: "missing_material", detail: "no chest item in inventory" };
		if (!placementCandidate(ctx.bot)) return { ok: false, code: "no_space", detail: "no adjacent placeable slot" };
		return { ok: true };
	},
	async execute(ctx) {
		const bot = ctx.bot;
		const item = carriedChest(bot);
		if (!item) return { ok: false, code: "missing_material", detail: "no chest item after precondition", worldDelta: null };
		const place = placementCandidate(bot);
		if (!place) return { ok: false, code: "no_space", detail: "no adjacent placeable slot", worldDelta: null };
		try {
			await withTimeout(bot.equip(item, "hand"), 3_000, "equip chest");
			await withTimeout(bot.placeBlock(place.ref, place.face), 5_000, "place chest");
			const loc = setLocation("chest", {
				x: place.at.x,
				y: place.at.y,
				z: place.at.z,
				dimension: ctx.snapshot?.dimension ?? "overworld",
				radius: 2,
				note: "auto-placed storage chest",
			});
			ctx.owned?.markPlaced?.({
				x: loc.x,
				y: loc.y,
				z: loc.z,
				dimension: loc.dimension,
				blockType: item.name,
				skill: "village.place-chest",
			});
			return {
				ok: true,
				code: "done",
				detail: { location: loc, item: item.name },
				worldDelta: { chestAt: { x: loc.x, y: loc.y, z: loc.z }, placedType: item.name },
			};
		} catch (e) {
			const msg = String(e?.message ?? "");
			const code = msg.includes("timed out") ? "timeout" : "failed";
			return { ok: false, code, detail: e.message, worldDelta: null };
		}
	},
});

export const _internal = { placementCandidate };
