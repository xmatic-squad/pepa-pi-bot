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
  - `PEPA_FAST_LLM_BASE_URL` (default `https://api.openai.com/v1`)
  - `PEPA_FAST_LLM_API_KEY` (required to enable; safe no-op otherwise)
  - `PEPA_FAST_LLM_MODEL` (required)
  - `PEPA_FAST_LLM_TIMEOUT_MS` (default 8000)
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

### rc.2 — (pending) Manifesto / Needs ladder
### rc.3 — (pending) Event-driven awareness + skill pre-emption

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
   export PEPA_FAST_LLM_BASE_URL="https://<timeweb-endpoint>/v1"
   export PEPA_FAST_LLM_API_KEY="<key>"
   export PEPA_FAST_LLM_MODEL="gpt-5-mini"
   ```
   The advisor still isn't auto-triggered in rc.1 — it's wired in rc.3.
4. **Pick the next rc** from PLAN.md.

## Workflow notes

- main is protected — only operator merges PRs
- Tests: `npm test` (279 green at last check), isolated under `/tmp/`
- The bot supervisor hot-restarts on file changes in `runtime/**/*.js`
- If something regresses badly, revert to v0.2.0-rc.3 commit `865aae1`
