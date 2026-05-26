// Pure predicate for the supervisor's fs.watch callback. Kept in its own
// module so it can be unit-tested without importing supervisor.js (which
// has top-level side effects like acquireLock).
//
// Returns true when a filename should trigger a child restart, false when
// the supervisor should ignore the event.

export function isWatchableJs(filename) {
	if (!filename) return false;
	if (!filename.endsWith(".js")) return false;
	// supervisor.js itself is excluded — restarting THIS process from
	// inside itself would require a separate exec, which we don't do.
	if (filename === "supervisor.js" || filename.endsWith("/supervisor.js")) return false;
	// Test files mustn't trigger restarts. Adding/editing a *.test.js was
	// causing the restart-storm observed live (2026-05-26): each new test
	// landed during a session burned a slot in MAX_RESTARTS_PER_MINUTE and
	// the supervisor would give up.
	if (filename.endsWith(".test.js")) return false;
	return true;
}
