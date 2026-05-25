// Rolling chat memory window. Per-speaker buffer of recent lines + a
// redaction pass so anything that *looks* like a secret never leaves the
// runtime (in a future Pi prompt, for instance).

const DEFAULT_MAX_LINES_PER_SPEAKER = 8;
const DEFAULT_MAX_SPEAKERS = 16;

// Patterns that catch the obvious shapes of secrets a Minecraft chat
// might surface accidentally (server-issued reset tokens, AuthMe
// password reminders, anyone pasting an API key). We never replace
// in-place — we drop the whole token and substitute a sentinel.
const REDACT_PATTERNS = [
	{ re: /\b(?:password|pass|pwd)\s*[:=]\s*\S+/gi, mask: "[REDACTED:password]" },
	{ re: /\b(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, mask: "[REDACTED:secret]" },
	{ re: /\b(?:sk|pk)-[A-Za-z0-9]{16,}\b/g, mask: "[REDACTED:key]" },
	{ re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, mask: "[REDACTED:jwt]" },
];

export function redact(text) {
	if (!text) return text;
	let out = String(text);
	for (const { re, mask } of REDACT_PATTERNS) {
		out = out.replace(re, mask);
	}
	return out;
}

export function createChatMemory({ maxLinesPerSpeaker = DEFAULT_MAX_LINES_PER_SPEAKER, maxSpeakers = DEFAULT_MAX_SPEAKERS } = {}) {
	// Map<speaker, Array<{ts, text}>> — insertion order doubles as recency.
	const lines = new Map();

	function evictOldestSpeakerIfNeeded() {
		while (lines.size > maxSpeakers) {
			const first = lines.keys().next().value;
			lines.delete(first);
		}
	}

	function append(speaker, text, ts = Date.now()) {
		if (!speaker || !text) return;
		const safe = redact(String(text));
		// Move-to-end semantics by re-inserting on each append, so the
		// LRU-style eviction in evictOldestSpeakerIfNeeded() reflects
		// who has been quiet longest.
		const existing = lines.get(speaker) ?? [];
		lines.delete(speaker);
		const next = existing.concat([{ ts, text: safe }]);
		if (next.length > maxLinesPerSpeaker) next.splice(0, next.length - maxLinesPerSpeaker);
		lines.set(speaker, next);
		evictOldestSpeakerIfNeeded();
	}

	function tail(speaker, n = maxLinesPerSpeaker) {
		const buf = lines.get(speaker);
		if (!buf) return [];
		return buf.slice(-n);
	}

	function all() {
		const out = [];
		for (const [speaker, buf] of lines) {
			for (const entry of buf) out.push({ speaker, ...entry });
		}
		out.sort((a, b) => a.ts - b.ts);
		return out;
	}

	function clear(speaker) {
		if (speaker) lines.delete(speaker);
		else lines.clear();
	}

	function size() {
		return lines.size;
	}

	return { append, tail, all, clear, size };
}
