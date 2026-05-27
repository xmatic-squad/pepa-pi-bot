-- pepa-pi-bot knowledge schema v1
-- Single-process SQLite store at state/<host>/knowledge.db.
-- Idempotent: applied on every boot. Migrations go below the CREATE TABLE
-- block, gated by schema_version.

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER NOT NULL PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

----------------------------------------------------------------------
-- Recipes (seeded from docs/minecraft-recipes.json + augmented by wiki)
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  shape           TEXT NOT NULL,             -- JSON array of rows
  shapeless       INTEGER NOT NULL DEFAULT 0,
  yields          INTEGER NOT NULL DEFAULT 1,
  requires_table  INTEGER NOT NULL DEFAULT 1, -- 0=hand,1=table,2=furnace,3=smithing
  source          TEXT,
  source_url      TEXT,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(name);

----------------------------------------------------------------------
-- Mob intel — what to do when you see a mob
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mob_intel (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,
  hostility         TEXT NOT NULL,           -- 'hostile' | 'neutral' | 'passive' | 'tamable'
  threat_level      INTEGER NOT NULL,        -- 1..5
  approach_range    REAL,                    -- blocks at which it engages
  burns_in_sun      INTEGER NOT NULL DEFAULT 0,
  ranged            INTEGER NOT NULL DEFAULT 0,
  weakness          TEXT,
  drops             TEXT,                    -- JSON array of names
  verdict_no_weapon TEXT,                    -- 'flee' | 'shelter' | 'avoid' | 'pillar'
  verdict_with_sword TEXT,                   -- 'kite' | 'attack' | 'avoid'
  notes             TEXT,
  source            TEXT,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mob_name ON mob_intel(name);

----------------------------------------------------------------------
-- Block intel — what tool, what drops, lighting
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS block_intel (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  required_tool TEXT,                        -- 'any'|'wood_pickaxe'|'stone_pickaxe'|'iron_pickaxe'|'shovel'|'axe'
  drops         TEXT,                        -- JSON array
  light_emit    INTEGER DEFAULT 0,
  walkable      INTEGER DEFAULT 1,
  notes         TEXT,
  source        TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_block_name ON block_intel(name);

----------------------------------------------------------------------
-- Lessons — generalised "what to do / what to avoid" learned over time
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lessons (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  text               TEXT NOT NULL,
  category           TEXT NOT NULL,          -- 'combat'|'pathing'|'crafting'|'survival'|'social'|'self-improve'
  trigger_skill      TEXT,
  trigger_hostile    TEXT,
  trigger_situation  TEXT,                   -- coarse hash key from scenario-memory
  avoid_skill        TEXT,
  prefer_skill       TEXT,
  confidence         REAL NOT NULL DEFAULT 0.5,
  applied_count      INTEGER NOT NULL DEFAULT 0,
  succeeded_count    INTEGER NOT NULL DEFAULT 0,
  source             TEXT NOT NULL,          -- 'postmortem'|'pi-coach'|'wiki'|'operator'|'rule'
  source_ref         TEXT
);
CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);
CREATE INDEX IF NOT EXISTS idx_lessons_skill   ON lessons(trigger_skill);
CREATE INDEX IF NOT EXISTS idx_lessons_hostile ON lessons(trigger_hostile);
CREATE INDEX IF NOT EXISTS idx_lessons_ts      ON lessons(ts);

----------------------------------------------------------------------
-- Death events — captured by coach/postmortem.js on every death
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deaths (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  x REAL, y REAL, z REAL,
  cause             TEXT,                    -- 'hostile'|'fall'|'lava'|'drowning'|'starvation'|'suffocation'|'other'|'unknown'
  hostile           TEXT,
  last_skill        TEXT,
  last_skill_code   TEXT,
  hp_at_death       REAL,
  food_at_death     REAL,
  inventory_lost    TEXT,                    -- JSON
  context_blob      TEXT,                    -- JSON: last 30s of events
  analysed          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deaths_ts        ON deaths(ts);
CREATE INDEX IF NOT EXISTS idx_deaths_analysed  ON deaths(analysed);
CREATE INDEX IF NOT EXISTS idx_deaths_cause     ON deaths(cause);

----------------------------------------------------------------------
-- Pi-extracted post-mortems linking back to deaths
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS postmortems (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  death_id      INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  cause         TEXT,
  lesson        TEXT,
  next_action   TEXT,
  raw_response  TEXT,
  source        TEXT,                        -- 'pi' | 'rule'
  FOREIGN KEY (death_id) REFERENCES deaths(id)
);
CREATE INDEX IF NOT EXISTS idx_postmortems_death ON postmortems(death_id);

----------------------------------------------------------------------
-- Points of interest — queryable spatial memory
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS poi (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                 -- 'tree'|'ore'|'water'|'mob_spawner'|'danger'|'foreign_build'|'base'|'chest'
  name        TEXT,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  cell_x      INTEGER NOT NULL,
  cell_z      INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  expires_at  INTEGER,
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_poi_cell ON poi(cell_x, cell_z);
CREATE INDEX IF NOT EXISTS idx_poi_kind ON poi(kind);

----------------------------------------------------------------------
-- Cached wiki pages (rc.2)
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wiki_pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  url         TEXT NOT NULL,
  body        TEXT,
  etag        TEXT,
  fetched_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

----------------------------------------------------------------------
-- Full chat log (durable; per-speaker LRU in memory is unchanged)
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  direction     TEXT NOT NULL,               -- 'in' | 'out'
  speaker       TEXT,
  text          TEXT NOT NULL,
  intent        TEXT,
  replied_with  TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_speaker ON chat_log(speaker);
CREATE INDEX IF NOT EXISTS idx_chat_ts      ON chat_log(ts);

----------------------------------------------------------------------
-- Self-rewrite audit
----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_changes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  proposal_slug   TEXT,
  files           TEXT,                      -- JSON array
  diff_hash       TEXT,
  outcome         TEXT,                      -- 'applied'|'rolled_back'|'rejected'
  notes           TEXT
);
