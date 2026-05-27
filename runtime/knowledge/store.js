// SQLite-backed knowledge store.
//
// Lazy-loads better-sqlite3 on first use so a fresh checkout without
// `npm install` still boots — the knowledge subsystem just goes into
// disabled mode and every public API becomes a safe no-op.
//
// Public API:
//   await ensureStore({ stateDir })   → opens (or reopens) the DB
//   getStore()                        → underlying Database handle or null
//   isAvailable()                     → boolean
//   closeStore()
//   runMaintenance()                  → idempotent vacuum/analyze
//
// All schema is in schema.sql alongside this file. Apply happens once on
// first open; subsequent opens are no-ops.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { info, warn, error as logError } from "../log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, "schema.sql");
const CURRENT_SCHEMA_VERSION = 1;

let _db = null;
let _disabled = false;
let _disabledReason = null;
let _Database = null;
let _loadAttempted = false;

async function loadDriver() {
	if (_Database) return _Database;
	if (_loadAttempted) return null;
	_loadAttempted = true;
	try {
		const mod = await import("better-sqlite3");
		_Database = mod.default ?? mod;
		return _Database;
	} catch (e) {
		_disabled = true;
		_disabledReason = e?.code === "ERR_MODULE_NOT_FOUND"
			? "better-sqlite3 not installed (run npm install)"
			: `better-sqlite3 load failed: ${e?.message ?? e}`;
		warn("knowledge", `${_disabledReason}; knowledge subsystem disabled`);
		return null;
	}
}

export function isAvailable() {
	return !_disabled && _db !== null;
}

export function disabledReason() {
	return _disabledReason;
}

export function getStore() {
	return _db;
}

export async function ensureStore({ stateDir } = {}) {
	if (_db) return _db;
	if (_disabled) return null;
	if (!stateDir) {
		warn("knowledge", "ensureStore called without stateDir; ignoring");
		return null;
	}
	const Database = await loadDriver();
	if (!Database) return null;
	try {
		mkdirSync(stateDir, { recursive: true });
		const dbPath = resolve(stateDir, "knowledge.db");
		const isNew = !existsSync(dbPath);
		_db = new Database(dbPath);
		_db.pragma("journal_mode = WAL");
		_db.pragma("synchronous = NORMAL");
		_db.pragma("foreign_keys = ON");
		const ddl = readFileSync(SCHEMA_PATH, "utf8");
		_db.exec(ddl);
		applyMigrations(_db);
		info("knowledge", `store opened at ${dbPath}${isNew ? " (new)" : ""}`);
		return _db;
	} catch (e) {
		_disabled = true;
		_disabledReason = `store open failed: ${e?.message ?? e}`;
		logError("knowledge", _disabledReason);
		try { _db?.close(); } catch {}
		_db = null;
		return null;
	}
}

function applyMigrations(db) {
	const row = db
		.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
		.get();
	const current = row?.version ?? 0;
	if (current >= CURRENT_SCHEMA_VERSION) return;
	// Migrations stack here when we cross schema versions in the future.
	// For v1 the schema.sql already defines everything; just record the version.
	db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
		CURRENT_SCHEMA_VERSION,
		Date.now(),
	);
}

export function closeStore() {
	if (!_db) return;
	try {
		_db.close();
	} catch (e) {
		warn("knowledge", `closeStore: ${e?.message ?? e}`);
	}
	_db = null;
}

export function runMaintenance() {
	if (!isAvailable()) return;
	try {
		_db.exec("ANALYZE");
	} catch (e) {
		warn("knowledge", `maintenance failed: ${e?.message ?? e}`);
	}
}

// Reset for tests. Not exported for runtime callers.
export function __resetForTests() {
	closeStore();
	_disabled = false;
	_disabledReason = null;
	_loadAttempted = false;
	_Database = null;
}
