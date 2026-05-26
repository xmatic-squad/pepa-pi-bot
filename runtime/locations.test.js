// locations.js writes to the real state/<host>/ on disk via the
// project's config.stateDir, so these tests run end-to-end against the
// active dev state dir. We pick obviously-fake location names with a
// timestamp suffix and clean up after ourselves so we never leave junk
// in the real state.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setLocation, getLocation, listLocations, removeLocation, nearestLocation } from "./locations.js";

function tag() {
	return `__test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

test("setLocation + getLocation round-trip", () => {
	const name = tag();
	try {
		const stored = setLocation(name, { x: 100, y: 64, z: -200, note: "smoke" });
		assert.equal(stored.x, 100);
		assert.equal(stored.note, "smoke");
		const got = getLocation(name);
		assert.equal(got.x, 100);
		assert.equal(got.z, -200);
	} finally {
		removeLocation(name);
	}
});

test("setLocation rounds floats", () => {
	const name = tag();
	try {
		const stored = setLocation(name, { x: 100.4, y: 64.7, z: -200.5 });
		assert.equal(stored.x, 100);
		assert.equal(stored.y, 65);
		assert.equal(stored.z, -200);
	} finally {
		removeLocation(name);
	}
});

test("setLocation rejects missing coords", () => {
	assert.throws(() => setLocation("bad", { x: 1, y: 2 }), /x\/y\/z/);
	assert.throws(() => setLocation(null, { x: 0, y: 0, z: 0 }), /name required/);
});

test("removeLocation returns false when absent", () => {
	assert.equal(removeLocation("__definitely_not_set"), false);
});

test("listLocations includes everything we put in", () => {
	const a = tag();
	const b = tag();
	try {
		setLocation(a, { x: 1, y: 64, z: 1 });
		setLocation(b, { x: 2, y: 64, z: 2 });
		const all = listLocations();
		assert.ok(all[a]);
		assert.ok(all[b]);
	} finally {
		removeLocation(a);
		removeLocation(b);
	}
});

test("nearestLocation picks the closer of two", () => {
	const a = tag();
	const b = tag();
	try {
		setLocation(a, { x: 0, y: 64, z: 0 });
		setLocation(b, { x: 100, y: 64, z: 100 });
		const near = nearestLocation({ x: 5, z: 5 });
		assert.equal(near.name, a);
	} finally {
		removeLocation(a);
		removeLocation(b);
	}
});
