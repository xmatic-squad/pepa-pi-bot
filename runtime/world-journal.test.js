import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorldJournal, _internal } from "./world-journal.js";

function tag() { return `__t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`; }

test("cellOf buckets by GRID_CELL", () => {
	assert.equal(_internal.cellOf(0, 0), "0,0");
	assert.equal(_internal.cellOf(15, 15), "0,0");
	assert.equal(_internal.cellOf(16, 16), "1,1");
	assert.equal(_internal.cellOf(-1, -1), "-1,-1");
});

test("append + nearest returns the entry we just stored", () => {
	const j = createWorldJournal();
	const name = tag();
	j.append({ kind: "chopped", name, at: { x: 100, y: 64, z: 200 } });
	const got = j.nearest({ kind: "chopped", x: 100, z: 200, radius: 16, limit: 5 });
	const ours = got.find((e) => e.name === name);
	assert.ok(ours, "expected to find our own entry back");
	assert.equal(ours.at.x, 100);
});

test("nearest ranks by distance and respects radius", () => {
	const j = createWorldJournal();
	const t = tag();
	j.append({ kind: "stone", name: t + "_far", at: { x: 100, y: 64, z: 100 } });
	j.append({ kind: "stone", name: t + "_near", at: { x: 5, y: 64, z: 5 } });
	const got = j.nearest({ kind: "stone", x: 0, z: 0, radius: 50, limit: 5 });
	const near = got.find((e) => e.name === t + "_near");
	const far = got.find((e) => e.name === t + "_far");
	assert.ok(near);
	assert.equal(far, undefined, "far entry > radius should be excluded");
});

test("leanestQuadrant returns the quadrant with fewest entries", () => {
	const j = createWorldJournal();
	const t = tag();
	for (let i = 0; i < 5; i++) {
		j.append({ kind: "dead_end", name: t, at: { x: 10 + i, y: 64, z: -10 - i } }); // NE
	}
	for (let i = 0; i < 2; i++) {
		j.append({ kind: "dead_end", name: t, at: { x: 10 + i, y: 64, z: 10 + i } }); // SE
	}
	const { best, counts } = j.leanestQuadrant({ x: 0, z: 0, radius: 64 });
	assert.ok(["SW", "NW"].includes(best), `expected unused quadrant, got ${best} counts=${JSON.stringify(counts)}`);
});

test("summary lists per-kind totals", () => {
	const j = createWorldJournal();
	j.append({ kind: "chopped", name: "oak_log", at: { x: 1, y: 1, z: 1 } });
	j.append({ kind: "chopped", name: "oak_log", at: { x: 2, y: 1, z: 2 } });
	j.append({ kind: "shelter", name: "shelter", at: { x: 0, y: 1, z: 0 } });
	const s = j.summary();
	assert.ok(s.byKind.chopped >= 2);
	assert.ok(s.byKind.shelter >= 1);
});
