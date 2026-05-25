// Chat intent classifier. Pure: given a message + bot context, returns one
// of a small fixed set of intents. The reply generator and the
// command-like-chat recorder both consume this, so the classifier is the
// single source of truth for "what kind of thing did the human just say?"
//
// Categories are intentionally small and stable. New conversational nuances
// should land as templates inside reply.js, not as new intents.

export const INTENTS = Object.freeze({
	GREETING: "greeting",
	STATUS_QUESTION: "status_question",
	ADDRESSED_BANTER: "addressed_banter",
	COMMAND_LIKE: "command_like", // ignored-and-recorded per Phase 0
	UNSAFE_REQUEST: "unsafe_request", // logged into escalations
	AMBIENT: "ambient", // nothing the bot should react to
});

// Unicode-aware word boundaries: JavaScript's \b only recognises ASCII
// word characters, so "привет" wouldn't match \bпривет\b. We use Unicode
// property escapes with lookarounds instead — any letter (Latin OR
// Cyrillic OR anything else) on either side disqualifies, so partial
// matches inside larger words still don't fire.
const NOT_LETTER_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_LETTER_AFTER = "(?![\\p{L}\\p{N}])";

function wordRe(words) {
	return new RegExp(`${NOT_LETTER_BEFORE}(?:${words.join("|")})${NOT_LETTER_AFTER}`, "iu");
}

const GREETING_RE = wordRe([
	"hi", "hello", "hey", "yo", "sup", "hola",
	"привет", "здаров", "здарова", "здорова", "здравствуй", "здравствуйте", "салам",
]);
const STATUS_RE = wordRe([
	"status", "how are you", "how['’]?s it going", "what are you doing",
	"whats up", "what['’]?s up",
	"чё делаешь", "что делаешь", "как ты", "как дела", "статус", "чем занят",
]);
const COMMAND_LIKE_RE = wordRe([
	"come", "follow", "build", "pause", "resume", "stop", "go to", "goto", "tp",
	"teleport", "give", "drop", "attack", "kill", "dig", "mine", "chop", "farm",
	"harvest", "sleep here",
	"иди сюда", "подойди", "следуй", "остановись", "стоп", "пауза", "строй",
	"копай", "дай",
]);
const UNSAFE_RE = wordRe([
	"grief", "kill .*player", "destroy .*house", "burn", "tnt", "lava bucket",
	"exploit", "dupe", "crash the server", "leak", "password", "api[_ ]?key",
]);

export function classifyIntent({ text, botName }) {
	if (!text) return INTENTS.AMBIENT;
	const trimmed = String(text).trim();
	if (!trimmed) return INTENTS.AMBIENT;
	const lower = trimmed.toLowerCase();
	const addressed = !!botName && lower.includes(String(botName).toLowerCase());

	if (UNSAFE_RE.test(lower)) return INTENTS.UNSAFE_REQUEST;

	if (addressed && COMMAND_LIKE_RE.test(lower)) return INTENTS.COMMAND_LIKE;

	if (addressed && STATUS_RE.test(lower)) return INTENTS.STATUS_QUESTION;

	if (GREETING_RE.test(lower)) return INTENTS.GREETING;

	if (addressed) return INTENTS.ADDRESSED_BANTER;

	return INTENTS.AMBIENT;
}
