# pepa v0.2.0 — status

> **Read this first** if you're continuing the iteration in a new session.
> It's the single source of truth for "where we are, what shipped, what's next".
>
> Live state snapshot lives in `state/<host>/` (gitignored). Code lives on `main`.
> Anything in this folder is shared knowledge for future contributors / sessions.

**Last update**: 2026-05-27, after rc.3 merged (PR #22).

**Current code**: `0.2.0-rc.3`. Live bot running on this version since
2026-05-27 15:32 (supervisor PID 31432, child PID rotates on hot-restart).

---

## What v0.2.0 is

Major iteration over v0.1.x. The bot acquires a **self-learning substrate**:
structured knowledge in SQLite, post-mortem analysis of every death by Pi,
Russian chat narration, retrieval-augmented dispatch (lessons override
planned actions), and a 30-min self-reflection loop where Pi asks the bot
*"are you in a loop?"*.

It also tightens the self-improvement pipeline: auto-patch now **opens a
PR for operator review** instead of cherry-picking onto `main` (branch
protection enforces — only operator can merge).

See [`docs/v0.2.0-self-learning.md`](../../docs/v0.2.0-self-learning.md)
for the original design doc.

---

## Shipped (rc.1 → rc.3)

### rc.1 — substrate ([PR #?]/9c2c56f)
- `runtime/knowledge/{schema.sql,store.js,seed.js,lessons.js,index.js}`
  — SQLite knowledge base at `state/<host>/knowledge.db`. 9 tables
  (recipes, mob_intel, block_intel, lessons, deaths, postmortems, poi,
  wiki_pages, chat_log, code_changes). Seeded from
  `docs/minecraft-recipes.json` + inline starter intel: 38 recipes,
  15 mobs (creeper/zombie/etc. with `verdict_no_weapon`), 30 blocks,
  12 starter lessons (creeper rule, "first wood→pickaxe→sword", etc.).
- `runtime/coach/postmortem.js` — `bot.on('death')` captures context
  (last skill, hostile, nearby journal, scenarios tail) → `deaths`
  table. Periodic drain (5min, ≤3 Pi calls/h) batches up to 8
  unanalysed deaths and asks Pi for generalised lessons. Pi reply
  parsed into `postmortems` + `lessons` rows.
- `runtime/coach/advice.js` + reflex hooks — `consultAdvice()` runs
  before dispatch in `curriculumReflex` and `defendReflex`. Lessons
  with `confidence ≥ 0.6` and matching `avoid_skill` swap the planned
  skill with `prefer_skill` (if it's in `SAFE_OVERRIDES`).
- `runtime/persona/chatter.js` — Russian narration in MC chat on skill
  transitions, threat spotted, day/night, respawn, milestone done.
  Rate-limited 8/h, min 75s gap, no-dup suppression.
- `auto-patch.js` switched to PR-open (no more direct cherry-pick to
  main). `PEPA_AUTO_PATCH_MERGE=cherry-pick` fallback for emergencies.
- Branch protection on `main`: 1 required approver, `enforce_admins:false`.

### rc.2 — P0 hardening ([PR #21]/e84148d)
- **PEPA_HEADLESS=1** — `pi -p` subprocesses (banter/coach/planner) no
  longer open a second MC connection.
  [extensions/mineflayer-bridge.ts](../../extensions/mineflayer-bridge.ts):
  `session_start` skips `connect("startup")` when env is set; pi-bridge
  sets it on every spawn.
- **Test state isolation** — `runtime/config.js` detects node test
  runner / `PEPA_STATE_DIR` and redirects `stateDir` to
  `/tmp/pepa-test-state-<pid>/`. `npm test` no longer pollutes live
  `scenarios.jsonl` / `world-journal.jsonl` / daily log.
- **defendReflex outcome bug fix** — `reportAdviceOutcome` was called
  with `succeeded:false` *before* the flee skill returned. Now wired
  through `dispatchDefendFlee` onComplete.
- **Mode-name → skill-id translation** in `coach/advice.js`. Pi-coach
  prefer values like `"night_shelter"`, `"self_preservation"`,
  `"hunger"` now map to `survive.sleep / survive.flee / survive.eat`.
- **Self-reflection loop** (`runtime/coach/reflect.js`). Every 30 min
  Pi gets asked *"are you making progress, or in a loop?"*. Verdict +
  summary + new lessons. Writes to `state/<host>/reflections/<ts>.md`,
  lessons land in DB with `source="pi-reflect"`. Rate-limited 2/h.

### rc.3 — escape mechanics ([PR #22]/865aae1)
- **`survive.pillar-up`** — vertical escape skill. Places dirt/cobble/
  planks under self, jumps onto it. Up to 8 steps per dispatch. NO
  pickaxe required.
- **Wedged-emergency reflex** — at top of `curriculumReflex`: if no
  hostile <6m AND position hasn't moved 16+ blocks in 60s AND placeable
  block in inv → force pillar-up. 2-min cooldown.
- **consult() in fallback path** — `curriculumReflex` wander/explore.far
  fallback now consults advice too. This closes the gap where Pi-coach
  lessons fired but the dispatcher's fallback bypassed them.
- **POI on death** — `coach/postmortem.js` calls
  `recordPOI({kind:"danger"})` on every death. 6h expiry. POI table now
  populates as bot plays.
- **SAFE_OVERRIDES** extended: + `survive.pillar-up`, +
  `village.choose-base`.

---

## Current state (2026-05-27 ~15:30, ~1.5h after rc.3)

Live DB:
```
deaths              28
postmortems         22  (coach analyzed all but 6 — backlog draining at 5min/batch)
lessons             34  (12 starter + 22 Pi-extracted)
lessons_applied     1   ← still very low; advice consult fires but most matches fail
poi                 22  (rc.3 fired recordPOI on every death since 14:17 deploy)
chat_log            0   (chatter narrates in MC chat but doesn't write to DB table yet)
reflections         2   (14:51, 15:22 — 30-min interval working)
```

The bot is **alive but still struggling**. Coach is producing high-quality
lessons (see `state/<host>/reflections/2026-05-27T12-21-58-656Z.md`:
"Я не продвинулся к цели… выбрать новое безопасное дневное место"), but:

1. Pi-coach + Pi-reflect routinely invent `prefer_skill` values that
   aren't registered skill ids (e.g. `choose.safe.surface`,
   `relocate.daylight`). `normalisePreferSkill` only knows mode names,
   not these. So even the right advice can't dispatch the right action.
2. The bot's home terrain (~608, 90) is genuinely bad — stone walls, no
   pickaxe to break out, hostiles spawn nearby. pillar-up *can* help but
   it needs a placeable block AND open sky above. In a closed cave it
   places dirt and hits a ceiling.
3. `gather.stone` returns `missing_tool` correctly (rc.0 was already
   fine here), but curriculum doesn't auto-route to `craft.wooden-pickaxe`
   — it just backs off and tries the same thing.

---

## Known issues / followups (rc.4 candidates)

Ranked roughly by impact.

### 1. Pi-suggested `prefer_skill` is often a hallucinated action name
**Symptom**: reflections produce `prefer: choose.safe.surface`,
`prefer: relocate.daylight`, `prefer: defend.self` — none are
registered skills. `SAFE_OVERRIDES` check fails, lesson falls back
to bare `avoid` (which dispatches nothing).

**Fix options**:
- (a) Include the full registered-skill list in the Pi prompt so it
  picks from valid IDs.
- (b) Add a fuzzy mapper: "choose|find|new + base|spot|place" →
  `village.choose-base`. "relocate|move + safe|day" → `explore.far`.
- (c) Both. (b) is a fallback safety net.

**Where**: `runtime/coach/{postmortem.js, reflect.js}` prompt builder +
`runtime/coach/advice.js` `normalisePreferSkill`.

### 2. Tool-progression auto-craft
**Symptom**: `gather.stone` returns `missing_tool` → curriculum backs
off → next tick tries `gather.stone` again → loop. Should auto-suggest
`craft.wooden-pickaxe`. Same pattern for axe-required gathering.

**Fix**: In curriculum or in a new "tool-need" reflex, when a gather
skill returns `missing_tool`, look up the tier requirement (already in
`block_intel.required_tool`) and route to the matching craft skill if
materials are available, else to the prerequisite gather skill.

**Where**: `runtime/reflex.js` or new `runtime/coach/tool-progression.js`.

### 3. `village.choose-base` should penalise danger POI
**Symptom**: bot may pick a new base that's adjacent to a danger POI
(a recent death site). rc.3 records the POIs but `choose-base` scoring
doesn't read them.

**Fix**: In `runtime/base-site.js` `scoreCurrentPosition`, query
`poiNearby({kind:"danger", x, z, radius: 32})` and subtract a penalty
proportional to recent danger count.

### 4. Pillar-up perimeter sense
**Symptom**: in a closed cave, pillar-up places a block and hits the
ceiling block above. Useless.

**Fix**: before starting pillar-up, scan a 3×3 above current head; if
solid blocks in the column path, abort and request `recovery.tunnel-out`
instead. Or walk to a column-clear cell within reach first.

### 5. `chat_log` table not populated
**Symptom**: 0 rows in `chat_log` despite bot narrating ~8 lines/hour.

**Fix**: `runtime/persona/chatter.js` `sendChat()` calls `logChat()`
from knowledge index. Also wire the inbound side in `bot.js`
`bot.on("chat")` handler.

### 6. Reflections don't write lessons to the DB until they parse
**Symptom**: confirmed working; just noting that the verdict + summary
themselves aren't queryable. Currently only `lessons` table benefits
from reflection.

**Possible fix**: add a `reflections` table mirroring the JSON output.
Or run lessons-from-reflection through the same advice path so they
get `applied_count`.

### 7. Re-narration spam
**Symptom**: persona narrated `за дровами` twice in 6 seconds after
hot-restart. Cooldown is per-process state, lost on restart.

**Fix**: persist `_lastNarrationAt` and `_narrationTimes` in a small
file in `state/<host>/` so restarts inherit the cooldown.

---

## Next session — quick start

1. **Read this file first.**
2. **Check live DB** for the latest counters:
   ```bash
   sqlite3 state/play.xmatic.team_25565/knowledge.db \
     "SELECT 'deaths', COUNT(*) FROM deaths
      UNION SELECT 'lessons', COUNT(*) FROM lessons
      UNION SELECT 'lessons_applied', COUNT(*) FROM lessons WHERE applied_count > 0
      UNION SELECT 'poi', COUNT(*) FROM poi;"
   ```
3. **Read the latest reflection** for current Pi assessment:
   ```bash
   ls -t state/play.xmatic.team_25565/reflections/ | head -1
   ```
4. **Check bot is alive**: `ps aux | grep "runtime/(bot|supervisor)"`.
5. **Pick a followup from §"Known issues"** (1 and 2 are the highest
   impact: actually-applying-lessons + tool progression).

---

## Workflow notes for next session

- `main` is protected — only the operator merges PRs. Auto-patch from
  the bot itself opens PRs via `gh pr create`.
- Tests: `npm test` (255+ green at last check). Tests run isolated under
  `/tmp/pepa-test-state-<pid>/` and don't pollute live state.
- The bot supervisor watches `runtime/**/*.js` and hot-restarts on
  file change. After merging a PR, `git pull` locally and the
  supervisor picks up the new code.
- Stop bot: `bash scripts/stop.sh`. Start: `npm run bot` (inside
  tmux is fine).
- Memory in `state/<host>/` is server-specific and gitignored.
- Don't bypass branch protection — the auto-mode classifier will block it.
