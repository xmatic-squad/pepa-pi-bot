# pepa v0.3.0 — status

Live tracking document for the v0.3.0 iteration ("Maslow + Awareness").
See [`PLAN.md`](./PLAN.md) for the full design.

## Shipped

### rc.1 — Live skill registry + Fast advisor scaffold
**Root problem solved**: 47/47 Pi-extracted lessons in v0.2.x had
`applied_count = 0` because Pi was hallucinating skill ids
(`relocate.surface`, `choose.safe.surface`, `survive.shelter`,
`gather.visible_log`, …) that don't exist in the registry. Both halves
fixed: (a) Pi now sees the real registry in its system prompt,
(b) anything that still slips through gets rejected at consult time.

- [`runtime/skill-registry.js`](../../runtime/skill-registry.js) —
  single source of truth wrapping `skills/index.js`. Exports:
  - `listSkillIds()` — live id list
  - `isRegistered(id)` — bool check
  - `describeSkill(id)` — id/title/timeoutMs
  - `skillRegistryPrompt({ limit })` — prompt-ready block grouped by
    namespace, with "USE ONLY THESE, never invent" instruction
- [`runtime/llm/provider.js`](../../runtime/llm/provider.js) —
  OpenAI-compatible chat client, env-driven:
  - `TIMEWEB_BASE_URL` (default `https://api.openai.com/v1`)
  - `TIMEWEB_API_KEY` (required to enable; safe no-op otherwise)
  - `TIMEWEB_MODEL` (required)
  - `TIMEWEB_TIMEOUT_MS` (default 8000)
  - Supports JSON-mode via `response_format: { type: "json_object" }`
  - Surfaces `not_configured`, `no_model`, `http_<status>`,
    `network_error`, `timeout`, `bad_json` codes
- [`runtime/coach/fast-advisor.js`](../../runtime/coach/fast-advisor.js)
  — tactical "what now?" tier. Scaffold only in rc.1; auto-trigger
  comes in rc.3.
  - `advise({snapshot, reason, recentSkillIds, lessonsTail})` →
    `{action: 'switch_skill'|'continue'|'wait', skillId?, rationale}`
  - Rejects any returned `skill_id` not in the live registry
  - Rate-limit: 6 calls/hour, 30s cooldown between calls
  - System prompt embeds registry; user prompt carries snapshot + trigger
- [`runtime/coach/advice.js`](../../runtime/coach/advice.js):
  - `normalisePreferSkill()` now returns `null` for anything not in
    registry/mode-map (was: passed through unchanged → dispatcher
    crashed at `runSkill()`)
  - Logs `warn` line when a hallucinated prefer_skill is dropped
- [`runtime/coach/postmortem.js`](../../runtime/coach/postmortem.js):
  - Pi prompt includes the live registry block (`skillRegistryPrompt`)
    with a "CRITICAL: USE ONLY THESE" instruction
  - On insert, drops `prefer_skill`/`avoid_skill` that's neither a
    registered id nor a known mode name; warn-logs the count
- [`runtime/coach/reflect.js`](../../runtime/coach/reflect.js) — same
  treatment as postmortem (registry in prompt + write-time filter)

Tests: 279 green (was 257 on rc.3). Added:
- `runtime/skill-registry.test.js` — 5 tests
- `runtime/llm/provider.test.js` — 9 tests
- `runtime/coach/fast-advisor.test.js` — 10 tests

### rc.2 — Manifesto / Needs ladder L0-L10
**Root problem solved**: pre-v0.3.0 the bot had no notion of intermediate
goals. The curriculum produced a single "next milestone" but no
hierarchy. So when the bot was wedged with no pickaxe, it kept trying
`explore.far` instead of recognising "I need wood → planks → pickaxe
first". Lessons from Pi couldn't help because there was no
internal-state language to express "L2 not satisfied".

The needs ladder gives the bot an explicit, ordered list of survival
concerns. Each reflex tick picks the LOWEST unsatisfied need and
dispatches a concrete skill toward it.

```
L0 alive          HP>5, food>0, no lava, no creeper@close
L1 food           ≥6 food items in inventory (or hungry+have any)
L2 tools_wood     wooden_pickaxe + wooden_axe + wooden_sword
L3 shelter_basic  bed placed nearby or in inventory
L4 tools_stone    stone tier (pickaxe + axe + sword)
L5 armor_basic    any chestplate equipped (pursue=null for now)
L6 food_security  ≥16 food items
L7 tools_iron     iron tier (pursue=gather.stone until craft.iron-* lands)
L8 armor_iron     iron chestplate (pursue=null for now)
L9 village_seed   bed + chest nearby
L10 village_full  global goal (never detected, falls through to curriculum)
```

- [`runtime/manifesto/needs.js`](../../runtime/manifesto/needs.js) —
  catalogue of 11 needs. Each has `detect(snapshot)` and
  `pursue(snapshot)`. Pursue can return `null` (e.g. armor levels) and
  the ladder gracefully skips, recording the level as "blocked".
- [`runtime/manifesto/state.js`](../../runtime/manifesto/state.js) —
  `pickActiveNeed(snapshot)` walks the ladder, picks the first
  unsatisfied + pursuable need. Returns `{need, skillId, args, blockedNeeds}`.
  3-second cache to avoid re-walking the ladder on every micro-tick.
  Validates `skillId` against the live registry (rc.1 piece) before
  returning — manifesto can't ship a hallucinated id.
- [`runtime/reflex.js`](../../runtime/reflex.js):
  - `curriculumReflex` now consults manifesto FIRST. If a need dictates
    a skill, that's what gets dispatched. The curriculum plan is the
    fallback when manifesto has no concrete pursue.
  - Tests can pass `ctx.disableManifesto = true` to exercise the
    curriculum branch in isolation.
- [`runtime/coach/reflect.js`](../../runtime/coach/reflect.js) — Pi
  self-reflection prompt now includes the active need
  (`L2 tools_wood → gather.logs (Деревянные орудия)`) so Pi can give
  level-appropriate advice instead of generic suggestions.

Tests: 315 green (was 279 on rc.1, +36 new):
- `runtime/manifesto/needs.test.js` — 24 tests (one per need detect/pursue)
- `runtime/manifesto/state.test.js` — 10 tests (ladder walk, caching, skipping)
- `runtime/reflex.test.js` — 2 new integration tests (manifesto-on
  overrides curriculum; well-fed bot pursues tools_stone)

### rc.4 (this commit batch) — Paradigm shift: TimeWeb-only LLM + improvement queue
**What changed**: Pi (CLI subscription) was removed from every
background loop. The bot's analytical LLM path (`coach/postmortem`,
`coach/reflect`) now goes through the same TimeWeb endpoint the fast
advisor already uses. The trigger system was extended with
emergency conditions (low HP + close hostile, lava under foot)
that bypass the long cooldown. Every recommendation is persisted to
SQLite with its outcome, and a deterministic tuner watches the
stats to flag underperforming triggers. The LLM also writes a
queue of "structural gaps" — missing skills or features —
that the operator reviews and implements by hand.

- [`runtime/coach/llm-call.js`](../../runtime/coach/llm-call.js) —
  shared `askAnalytical()` helper that wraps `runtime/llm/provider.js#complete()`
  with a longer (30s) timeout suitable for postmortem and reflect.
- [`runtime/coach/postmortem.js`](../../runtime/coach/postmortem.js):
  - Drain loop runs through TimeWeb, not Pi CLI
  - `buildPrompt()` returns `{system, user}` (was a single concatenated string)
  - Reply schema includes `improvements[]` for missing-skill callouts
  - `lessons` source is now `timeweb-coach` (was `pi-coach`)
- [`runtime/coach/reflect.js`](../../runtime/coach/reflect.js) — same
  treatment. `lessons` source is now `timeweb-reflect`.
- [`runtime/coach/advisor-trigger.js`](../../runtime/coach/advisor-trigger.js):
  - **Emergency triggers** added: HP≤6 + hostile≤8b, or lava under foot.
    Use a much shorter 20s cooldown — wait-on-cooldown would be lethal.
  - Active need now passed to the LLM so suggestions track the manifesto.
  - Every recommendation is `insertRecommendation()`-ed; reflex marks
    `applied=1` when it dispatches, and `outcome_ok` when the skill returns.
- [`runtime/knowledge/schema.sql`](../../runtime/knowledge/schema.sql):
  two new tables.
  - `advisor_recommendations` — ground truth for the LLM trail with
    full token usage + outcome attribution
  - `improvement_requests` — operator-facing queue. Dedup by title
    bumps `votes` instead of inserting duplicates.
- [`runtime/coach/trigger-tuner.js`](../../runtime/coach/trigger-tuner.js)
  (new) — hourly: reads 24h of recommendation stats, flags low-success
  triggers and expensive-prompt-mediocre-payoff cases as
  `improvement_requests` with `source="tuner"`. No LLM call needed
  — pure SQL.
- [`runtime/llm/provider.js`](../../runtime/llm/provider.js):
  `complete()` now returns `usage: {in, out, total}` and logs
  `in=Nt/out=Mt` on every call.
- [`runtime/coach/fast-advisor.js`](../../runtime/coach/fast-advisor.js):
  `getUsageSnapshot()` aggregates total tokens across the session;
  surfaces in `scripts/list-improvements.js --stats`.
- [`scripts/list-improvements.js`](../../scripts/list-improvements.js)
  (new) — operator CLI. `--status open` (default), `--stats`,
  `--done <id> [note]`, `--inprogress <id>`, `--reject <id>`,
  `--source <postmortem|reflect|advisor|tuner|manual>`,
  `--category <skill|tuning|...>`.

Cost measurement (smoke-test against TimeWeb gpt-5.4-mini):
  per advise(): ~705 input + 45 output = ~750 tokens
  rate cap: 6 calls/hour
  worst case @ full hourly cap: ~108K tokens/day
  estimated cost (OpenAI gpt-5-mini reference pricing): ~$0.60/month

Tests: 360 green (was 332 on v0.3.0-rc.3, +28 new):
  +3  abortSignal tests in skills/contract.test.js
  +13 advisor-trigger tests
  +4  emergency-trigger tests
  +4  knowledge-recommendation tests
  +3  knowledge-improvement tests
  +2  postmortem/reflect rewrites for TimeWeb path
  +7  trigger-tuner tests (low success / expensive / healthy / dedup)

### rc.3 — Event-driven awareness + skill pre-emption
**Root problem solved**: in v0.2.x the reflex was purely polling. The
loop took a snapshot every DISPATCH_INTERVAL_MS (~2s) and decided what
to do, but anything that happened **between** ticks was invisible.
Concretely: when the operator dug a path that let the bot fall to a
new area, the bot continued executing its prior `explore.far` against
stale assumptions until the next tick. By then it had wandered further
off course, and the cycle never broke. Same problem for hostile spawns
and HP plunges — the reflex saw them only after the current skill ran
its 30-90s timeout.

This rc gives the reflex an event-driven layer that **preempts** the
in-flight skill within ~100ms of an environmental shock.

- [`runtime/awareness/events.js`](../../runtime/awareness/events.js) —
  wires direct `bot.on(...)` listeners and surfaces them as flags + an
  optional preempt callback:
  - `bot.on("move")` — single-tick position jump ≥ 5 blocks (teleport,
    fall, pathfinder snap, operator pushed us) → `forced_move`
  - `bot.on("health")` — HP drop ≥ 2 in one tick → `health_plunge`
  - `bot.on("entitySpawn")` — hostile mob spawns within 12 blocks →
    `hostile_added`
  - `bot.on("blockUpdate")` — block change within manhattan 4 →
    `env_changed` (informational only, NOT preempting; throttled 800ms)
- [`runtime/skills/index.js`](../../runtime/skills/index.js):
  - `RUNNER_CODES.PREEMPTED` — new stable failure code
  - `runSkill()` now races `execute()` with `ctx.abortSignal`. If the
    signal fires mid-await, the skill returns `{ ok: false, code:
    "preempted" }` within one microtask — no skill code change needed.
    Long-running skills (`gather.logs`, `explore.far`,
    `recovery.tunnel-out`, `survive.pillar-up`) get this for free.
- [`runtime/bot.js`](../../runtime/bot.js):
  - `dispatchAction` creates a fresh `AbortController` per dispatch
    and stores it on `reflexCtx.currentAbort` + `reflexCtx.abortSignal`
  - `bot.once("spawn")` calls `attachAwareness(bot, {onPreempt})`
    where `onPreempt` aborts the current dispatch
  - `reflexCtx.lastPreempt` records the most recent shock for
    snapshot/telemetry consumers

Tests: 332 green (was 315 on rc.2, +17 new):
- `runtime/awareness/events.test.js` — 12 tests (each event type,
  thresholds, throttling, hostile filter)
- `runtime/skills/contract.test.js` — 3 new preempt tests (mid-flight
  abort, pre-armed signal, clean signal doesn't interfere)
- 2 extra contract sanity checks shaken out by signal plumbing

## Next session quick start

1. **Read PLAN.md** for the full design and per-rc breakdown.
2. **Check live DB** to see if Pi-lesson application is improving:
   ```bash
   sqlite3 state/play.xmatic.team_25565/knowledge.db \
     "SELECT source, COUNT(*) AS n, SUM(applied_count > 0) AS applied
      FROM lessons GROUP BY source ORDER BY n DESC;"
   ```
   After rc.1 deploys, expect Pi-coach/Pi-reflect `applied` count to
   start growing as the registry feedback closes the loop.
3. **Set fast-advisor env when ready to test**:
   ```bash
   export TIMEWEB_BASE_URL="https://<timeweb-endpoint>/v1"
   export TIMEWEB_API_KEY="<key>"
   export TIMEWEB_MODEL="gpt-5-mini"
   ```
   The advisor still isn't auto-triggered in rc.1 — it's wired in rc.3.
4. **Pick the next rc** from PLAN.md.

## Workflow notes

- main is protected — only operator merges PRs
- Tests: `npm test` (279 green at last check), isolated under `/tmp/`
- The bot supervisor hot-restarts on file changes in `runtime/**/*.js`
- If something regresses badly, revert to v0.2.0-rc.3 commit `865aae1`
