import { test } from "node:test";
import assert from "node:assert/strict";

import { getSkill } from "./index.js";
import { _internal as exploreFarInternal } from "./explore-far.js";
import { digEscapeTunnel, _internal } from "./recovery-tunnel-out.js";

function makePos(x, y, z) {
	return {
		x, y, z,
		offset(dx, dy, dz) { return makePos(x + dx, y + dy, z + dz); },
		clone() { return makePos(x, y, z); },
	};
}

function makeBlock(name, x, y, z) {
	return {
		name,
		boundingBox: name === "air" ? "empty" : "block",
		position: makePos(x, y, z),
	};
}

function makeBot(blocks = {}) {
	return {
		entity: { position: makePos(0, 64, 0) },
		blockAt(pos) {
			const x = Math.floor(pos.x);
			const y = Math.floor(pos.y);
			const z = Math.floor(pos.z);
			const name = blocks[`${x},${y},${z}`] ?? "stone";
			return makeBlock(name, x, y, z);
		},
		canDigBlock(block) { return block.name !== "bedrock"; },
	};
}

test("recovery.tunnel-out is registered", () => {
	const skill = getSkill("recovery.tunnel-out");
	assert.ok(skill);
	assert.equal(skill.preconditions({}).ok, false);
	assert.equal(skill.preconditions({ bot: makeBot() }).ok, true);
});

test("tunnel ranking prefers the most-free safe cardinal", () => {
	const blocks = {};
	// North is already a two-high open tunnel with solid floor.
	for (let step = 1; step <= 3; step++) {
		blocks[`0,64,${-step}`] = "air";
		blocks[`0,65,${-step}`] = "air";
		blocks[`0,63,${-step}`] = "dirt";
	}
	// West is blocked by a player/build-looking block and must be unusable.
	blocks["-1,64,0"] = "oak_planks";

	const ranked = _internal.rankTunnelDirections(makeBot(blocks), 3);
	assert.equal(ranked[0].name, "N");
	assert.equal(ranked[0].usable, true);
	const west = ranked.find((d) => d.name === "W");
	assert.equal(west.usable, false);
	assert.deepEqual(west.blockers.map((b) => b.name), ["oak_planks"]);
});

test("safe dig guard allows natural blocks and rejects build/storage blocks", () => {
	const bot = makeBot();
	assert.equal(_internal.isSafeTunnelDigTarget(bot, makeBlock("dirt", 1, 64, 0)), true);
	assert.equal(_internal.isSafeTunnelDigTarget(bot, makeBlock("oak_leaves", 1, 64, 0)), true);
	assert.equal(_internal.isSafeTunnelDigTarget(bot, makeBlock("oak_log", 1, 64, 0)), true);
	assert.equal(_internal.isSafeTunnelDigTarget(bot, makeBlock("oak_planks", 1, 64, 0)), false);
	assert.equal(_internal.isSafeTunnelDigTarget(bot, makeBlock("chest", 1, 64, 0)), false);
	assert.equal(_internal.isSafeTunnelDigTarget(bot, makeBlock("bedrock", 1, 64, 0)), false);
});

test("tunnel-out does not count jumping in place as escape", async () => {
	const blocks = {};
	for (let step = 1; step <= 3; step++) {
		blocks[`0,64,${-step}`] = "air";
		blocks[`0,65,${-step}`] = "air";
		blocks[`0,63,${-step}`] = "dirt";
	}
	// Make the other cardinals unusable so the test exercises one clean
	// tunnel candidate and then verifies vertical-only movement is rejected.
	blocks["1,64,0"] = "oak_planks";
	blocks["0,64,1"] = "oak_planks";
	blocks["-1,64,0"] = "oak_planks";

	const bot = makeBot(blocks);
	bot.dig = async (block) => {
		blocks[`${block.position.x},${block.position.y},${block.position.z}`] = "air";
	};
	bot.setControlState = (control, on) => {
		if (control === "jump" && on) {
			bot.entity.position = makePos(bot.entity.position.x, bot.entity.position.y + 1, bot.entity.position.z);
		}
	};

	const res = await digEscapeTunnel(bot, { maxSteps: 3, minMove: 0.75, pushMs: 0 });
	assert.equal(res.ok, false);
	assert.equal(res.code, "wedged");
	assert.match(res.detail.error, /moved only 0\.00 horizontally/);
});

test("explore.far blind fallback does not report done when position is unchanged", async () => {
	const blocks = {};
	const bot = makeBot(blocks);
	bot.look = async () => {};
	bot.lookAt = async () => {};
	bot.dig = async (block) => {
		blocks[`${block.position.x},${block.position.y},${block.position.z}`] = "air";
	};
	bot.setControlState = () => {}; // no physics movement in this wedged simulation

	const res = await exploreFarInternal.blindWalkOrTunnelOut(bot, {
		yaw: 0,
		dirName: "E",
		blindMs: 0,
		tunnelPushMs: 0,
	});
	assert.equal(res.ok, false);
	assert.equal(res.code, "wedged");
	assert.equal(res.detail.mode, "blind");
	assert.equal(res.detail.dir, "E");
});
