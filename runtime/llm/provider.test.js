import { test } from "node:test";
import assert from "node:assert/strict";

import { isAvailable, getConfig, complete, __testing } from "./provider.js";

const { tryParseJson, ENV } = __testing;

test("isAvailable: false when no API key in env", () => {
	const prev = process.env[ENV.API_KEY];
	delete process.env[ENV.API_KEY];
	try {
		assert.equal(isAvailable(), false);
	} finally {
		if (prev !== undefined) process.env[ENV.API_KEY] = prev;
	}
});

test("isAvailable: true when API key set", () => {
	const prev = process.env[ENV.API_KEY];
	process.env[ENV.API_KEY] = "test-key";
	try {
		assert.equal(isAvailable(), true);
	} finally {
		if (prev === undefined) delete process.env[ENV.API_KEY];
		else process.env[ENV.API_KEY] = prev;
	}
});

test("getConfig: reflects env overrides and strips trailing slash", () => {
	const prev = {
		base: process.env[ENV.BASE_URL],
		key: process.env[ENV.API_KEY],
		model: process.env[ENV.MODEL],
	};
	process.env[ENV.BASE_URL] = "https://api.example.com/v1/";
	process.env[ENV.API_KEY] = "abc";
	process.env[ENV.MODEL] = "gpt-fast";
	try {
		const cfg = getConfig();
		assert.equal(cfg.baseUrl, "https://api.example.com/v1");
		assert.equal(cfg.apiKey, "abc");
		assert.equal(cfg.model, "gpt-fast");
		assert.ok(cfg.timeoutMs > 0);
	} finally {
		for (const [k, v] of [[ENV.BASE_URL, prev.base], [ENV.API_KEY, prev.key], [ENV.MODEL, prev.model]]) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("complete: not_configured when no API key", async () => {
	const prev = process.env[ENV.API_KEY];
	delete process.env[ENV.API_KEY];
	try {
		const res = await complete({ system: "hi", user: "hi" });
		assert.equal(res.ok, false);
		assert.equal(res.code, "not_configured");
	} finally {
		if (prev !== undefined) process.env[ENV.API_KEY] = prev;
	}
});

test("complete: no_model when key is set but model isn't", async () => {
	const prev = { key: process.env[ENV.API_KEY], model: process.env[ENV.MODEL] };
	process.env[ENV.API_KEY] = "x";
	delete process.env[ENV.MODEL];
	try {
		const res = await complete({ system: "s", user: "u" });
		assert.equal(res.ok, false);
		assert.equal(res.code, "no_model");
	} finally {
		if (prev.key === undefined) delete process.env[ENV.API_KEY];
		else process.env[ENV.API_KEY] = prev.key;
		if (prev.model !== undefined) process.env[ENV.MODEL] = prev.model;
	}
});

test("tryParseJson: parses naked, fenced, and embedded JSON", () => {
	assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 });
	assert.deepEqual(tryParseJson('```json\n{"a":2}\n```'), { a: 2 });
	assert.deepEqual(tryParseJson('prose before {"a":3} prose after'), { a: 3 });
	assert.equal(tryParseJson("nope"), null);
	assert.equal(tryParseJson(""), null);
});

test("complete: real fetch path uses Bearer header and POSTs JSON", async () => {
	// Stub global fetch to capture the request.
	const calls = [];
	const stub = async (url, opts) => {
		calls.push({ url, opts });
		return {
			ok: true,
			json: async () => ({
				choices: [{ message: { content: JSON.stringify({ verdict: "loop", action: "wander" }) } }],
			}),
		};
	};
	const origFetch = globalThis.fetch;
	globalThis.fetch = stub;
	const prev = { key: process.env[ENV.API_KEY], model: process.env[ENV.MODEL], base: process.env[ENV.BASE_URL] };
	process.env[ENV.API_KEY] = "secret-123";
	process.env[ENV.MODEL] = "gpt-fast";
	process.env[ENV.BASE_URL] = "https://example/v1";
	try {
		const res = await complete({ system: "be terse", user: "what now?", json: true });
		assert.equal(res.ok, true);
		assert.deepEqual(res.text, { verdict: "loop", action: "wander" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://example/v1/chat/completions");
		assert.equal(calls[0].opts.method, "POST");
		assert.equal(calls[0].opts.headers["Authorization"], "Bearer secret-123");
		const sent = JSON.parse(calls[0].opts.body);
		assert.equal(sent.model, "gpt-fast");
		assert.equal(sent.messages[0].role, "system");
		assert.equal(sent.messages[1].role, "user");
		assert.equal(sent.response_format.type, "json_object");
	} finally {
		globalThis.fetch = origFetch;
		for (const [k, v] of [[ENV.API_KEY, prev.key], [ENV.MODEL, prev.model], [ENV.BASE_URL, prev.base]]) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("complete: network error surfaces as code=network_error", async () => {
	const origFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("boom"); };
	const prev = { key: process.env[ENV.API_KEY], model: process.env[ENV.MODEL] };
	process.env[ENV.API_KEY] = "x";
	process.env[ENV.MODEL] = "m";
	try {
		const res = await complete({ system: "s", user: "u" });
		assert.equal(res.ok, false);
		assert.equal(res.code, "network_error");
		assert.match(res.detail, /boom/);
	} finally {
		globalThis.fetch = origFetch;
		if (prev.key === undefined) delete process.env[ENV.API_KEY];
		else process.env[ENV.API_KEY] = prev.key;
		if (prev.model === undefined) delete process.env[ENV.MODEL];
		else process.env[ENV.MODEL] = prev.model;
	}
});

test("complete: http error surfaces as http_<status>", async () => {
	const origFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "bad key" });
	const prev = { key: process.env[ENV.API_KEY], model: process.env[ENV.MODEL] };
	process.env[ENV.API_KEY] = "x";
	process.env[ENV.MODEL] = "m";
	try {
		const res = await complete({ system: "s", user: "u" });
		assert.equal(res.ok, false);
		assert.equal(res.code, "http_401");
	} finally {
		globalThis.fetch = origFetch;
		if (prev.key === undefined) delete process.env[ENV.API_KEY];
		else process.env[ENV.API_KEY] = prev.key;
		if (prev.model === undefined) delete process.env[ENV.MODEL];
		else process.env[ENV.MODEL] = prev.model;
	}
});
