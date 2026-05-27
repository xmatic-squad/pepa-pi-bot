// OpenAI-compatible chat client for the "fast advisor" tier.
//
// The original "coach" loop uses Pi via the CLI subprocess (5-15s latency,
// rate-limited to a few calls per hour). That's appropriate for deep
// post-mortem analytics but useless when the bot needs tactical advice
// right now ("I'm wedged in a pit, what should I do?").
//
// This provider opens a parallel path: any OpenAI-compatible HTTP endpoint
// (TimeWeb is the default — same env var convention as the user's other
// projects — but OpenAI direct, Groq, OpenRouter, and local Ollama with
// the OpenAI shim all work with the same plumbing) producing a structured
// JSON answer in ≤8 seconds.
//
// Configuration is strictly env-driven. The provider is a NO-OP unless
// TIMEWEB_API_KEY is set, so it's safe to ship the code disabled.

import { info, warn } from "../log.js";

const ENV = {
	BASE_URL: "TIMEWEB_BASE_URL",
	API_KEY: "TIMEWEB_API_KEY",
	MODEL: "TIMEWEB_MODEL",
	TIMEOUT_MS: "TIMEWEB_TIMEOUT_MS",
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// 20s default — TimeWeb's hosted agent endpoint takes 5-15s for the
// fast-advisor prompt (registry block + snapshot context). 8s was too
// tight and produced spurious timeouts in smoke tests. OpenAI direct
// returns much faster (<2s); the env var overrides if needed.
const DEFAULT_TIMEOUT_MS = 20000;

export function isAvailable() {
	return !!process.env[ENV.API_KEY];
}

export function getConfig() {
	return {
		baseUrl: (process.env[ENV.BASE_URL] || DEFAULT_BASE_URL).replace(/\/+$/, ""),
		apiKey: process.env[ENV.API_KEY] || null,
		model: process.env[ENV.MODEL] || null,
		timeoutMs: Number(process.env[ENV.TIMEOUT_MS]) || DEFAULT_TIMEOUT_MS,
	};
}

/**
 * complete({ system, user, json, model?, timeoutMs? })
 *   → { ok: true, text, raw, latencyMs } | { ok: false, code, detail, latencyMs }
 *
 * `json: true` requests JSON-mode (response_format) and returns the
 * parsed object as `text`. If the provider doesn't honour JSON-mode the
 * call still works but caller is responsible for parsing.
 */
export async function complete({
	system,
	user,
	json = false,
	model,
	timeoutMs,
} = {}) {
	const cfg = getConfig();
	if (!cfg.apiKey) {
		return { ok: false, code: "not_configured", detail: `set ${ENV.API_KEY}`, latencyMs: 0 };
	}
	const useModel = model || cfg.model;
	if (!useModel) {
		return { ok: false, code: "no_model", detail: `set ${ENV.MODEL} env or pass model arg`, latencyMs: 0 };
	}

	const body = {
		model: useModel,
		messages: [
			system ? { role: "system", content: system } : null,
			{ role: "user", content: user ?? "" },
		].filter(Boolean),
		temperature: 0.3,
	};
	if (json) {
		body.response_format = { type: "json_object" };
	}

	const url = `${cfg.baseUrl}/chat/completions`;
	const startedAt = Date.now();
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs ?? cfg.timeoutMs);

	let resp;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (e) {
		clearTimeout(t);
		const latency = Date.now() - startedAt;
		const aborted = e?.name === "AbortError";
		return {
			ok: false,
			code: aborted ? "timeout" : "network_error",
			detail: e?.message ?? String(e),
			latencyMs: latency,
		};
	}
	clearTimeout(t);

	const latencyMs = Date.now() - startedAt;
	if (!resp.ok) {
		let body;
		try { body = await resp.text(); } catch { body = "<no body>"; }
		warn("llm", `${useModel} ${resp.status}: ${body.slice(0, 200)}`);
		return {
			ok: false,
			code: `http_${resp.status}`,
			detail: body.slice(0, 500),
			latencyMs,
		};
	}

	let payload;
	try {
		payload = await resp.json();
	} catch (e) {
		return { ok: false, code: "bad_json", detail: e?.message ?? "parse error", latencyMs };
	}

	const text = payload?.choices?.[0]?.message?.content;
	if (typeof text !== "string") {
		return { ok: false, code: "no_content", detail: "no choices[0].message.content", latencyMs };
	}

	let parsed = text;
	if (json) {
		parsed = tryParseJson(text);
		if (parsed === null) {
			return { ok: false, code: "bad_json", detail: text.slice(0, 200), latencyMs };
		}
	}

	info("llm", `${useModel} ok (${latencyMs}ms, ${text.length}ch)`);
	return { ok: true, text: parsed, raw: text, latencyMs };
}

function tryParseJson(text) {
	if (!text) return null;
	const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
	try { return JSON.parse(trimmed); } catch {}
	const m = trimmed.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try { return JSON.parse(m[0]); } catch { return null; }
}

// Test exports
export const __testing = { ENV, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, tryParseJson };
