# pepa v0.3.1 — PRD: LLM prompt cost optimization

**Status**: Design draft. No code in this version yet — this PRD is the
spec future commits implement against. Owner: operator.
**Trigger**: TimeWeb admin panel after first day of v0.3.0 live:
~34K tokens used in a half-day session (mostly bot + some smoke).
At the 6-calls/hour cap that projects to **~480 ₽/month** (101 ₽/M in,
608 ₽/M out for gpt-5.4-mini). Manageable but worth shrinking — most
of the per-call cost is repeated infrastructure tokens, not the
situational signal the model actually uses.

## Goals

1. Cut per-advise() input tokens from ~800 → ≤300 (target 250).
2. Preserve correctness: the LLM must still see enough context to
   produce a valid `skill_id` from the registry and a useful rationale.
3. Keep all changes transparent to the rest of the runtime — the
   public `advise()` / `complete()` surface area doesn't change.

Non-goals:
- Switching providers. TimeWeb stays.
- Caching the LLM's *responses* (cache key would be situational, too
  many misses to be worth the bookkeeping).
- Touching the analytical loops (postmortem / reflect). They're called
  less often and need fuller context; cost there is acceptable.

## Cost breakdown — what we're optimizing

Measured on live advise() calls (TimeWeb gpt-5.4-mini, single advisor
trigger):

| Block                                | tokens (avg) | % of call |
|--------------------------------------|--------------|-----------|
| `skillRegistryPrompt({limit:1800})`  | ~450         | 56%       |
| System instructions (rules + JSON)   | ~200         | 25%       |
| User snapshot + threats + need + recent | ~150     | 19%       |
| **Total input**                      | **~800**     | **100%**  |
| Output (JSON answer)                 | ~40-50       | —         |

The registry block dominates. It currently lists all 30+ registered
skills with their human titles. The model rarely needs the full list —
most decisions are within 5-8 plausible skills per trigger.

## Proposed changes

### 1. Compact registry format (P1, biggest win)

Drop human titles and the per-skill descriptions; switch to
namespace-grouped, comma-separated id lists.

**Before** (~450 tokens):
```
Valid skill ids (USE ONLY THESE for avoid_skill / prefer_skill):
  craft:
    - craft.bed — Craft bed
    - craft.chest — Craft chest
    - craft.furnace — Craft furnace
    ...
  survive:
    - survive.acquire-food — Acquire food
    - survive.eat — Eat
    ...
```

**After** (~100 tokens):
```
Valid skill ids (USE EXACTLY one of these or null):
  craft: bed, chest, furnace, planks, sticks, torch, wooden-axe,
         wooden-pickaxe, wooden-sword, stone-axe, stone-pickaxe, stone-sword
  survive: acquire-food, eat, flee, pillar-up, sleep
  gather: logs, stone, wool
  recovery: tunnel-out
  explore: far, wander
  village: build-shelter, choose-base, deposit-surplus, place-chest
  farm: wheat
  diag: physics, scan, match
```

Saving: **~350 tokens/call**.

Implementation: add `skillRegistryPrompt({ mode: "compact" })` mode in
`runtime/skill-registry.js`. Default mode stays for slow analytical
loops (postmortem / reflect) which can afford the verbose form.

### 2. Need-scoped registry (P2, additional ~50 token saving)

When `activeNeed` is set, filter the registry to skills plausibly
relevant to that level + always-available safety skills.

Relevance table (manually curated, lives in `runtime/manifesto/needs.js`):

| Need              | Relevant skills (in addition to ALWAYS set)               |
|-------------------|------------------------------------------------------------|
| alive             | survive.flee, survive.eat, recovery.tunnel-out             |
| food              | survive.acquire-food, survive.eat, farm.wheat              |
| tools_wood        | gather.logs, craft.planks, craft.sticks, craft.wooden-*    |
| shelter_basic     | gather.wool, craft.bed, village.build-shelter, village.choose-base |
| tools_stone       | gather.stone, craft.sticks, craft.stone-*                  |
| armor_basic       | gather.wool (placeholder)                                  |
| food_security     | farm.wheat, survive.acquire-food                           |
| tools_iron        | gather.stone                                               |
| armor_iron        | (none — no skill yet)                                      |
| village_seed      | craft.chest, village.deposit-surplus, village.build-shelter |
| village_full      | (full registry)                                            |
| ALWAYS            | survive.flee, survive.pillar-up, recovery.tunnel-out,      |
|                   | explore.far, explore.wander                                |

Compact + scoped = **~50 tokens** for the registry block (down from 450).

Add a `prompt-builder.test.js` checking that:
- `survive.flee` is always present (emergency safety)
- The recommended skill from the previous call would still be in the
  scoped registry (regression protection)

### 3. Snapshot pruning (P3, ~50 tokens)

The user-prompt snapshot includes fields the LLM rarely consults:
`weather`, `experience`, `dimension`, `biome`, `players[]`. Drop them
from the advise() user-prompt builder. Keep `position`, `hp`, `food`,
`isDay`, `closestHostile`, `activeNeed`, `recent dispatches`,
`hazards.footBlock` (lava detection), top inventory keys.

### 4. Prompt caching — investigation (P4)

OpenAI and Anthropic both support implicit prompt caching: when ≥1024
prefix tokens are identical across consecutive requests, the prefix
is billed once. TimeWeb's docs are silent on this.

Task: probe whether TimeWeb passes through OpenAI's `prompt_tokens_details.cached_tokens`
field. If yes, *increase* the system prefix length (keep verbose registry)
because cached input is ~10x cheaper than fresh. If no, full optimization
1+2+3 still wins.

Add a one-off check in `scripts/check-timeweb.js`: print
`payload?.usage?.prompt_tokens_details?.cached_tokens` if present.

### 5. Telemetry — per-trigger token attribution (P5)

Today `advisor_recommendations` records `tokens_in` per row but the
operator has no easy view of *which trigger types* are most expensive.

Extend `scripts/list-improvements.js --stats` to also print per-trigger:
```
trigger_reason         total  applied  ok  fail  avg_in  avg_out  cost_₽  share%
wedged_*                  20       18   3   15    280    45        2.1     45%
emergency_*                3        3   2    1    240    50        0.3      6%
repeat_*                   8        7   0    7    260    42        0.8     17%
preempt_retry_*           14       12   2   10    290    44        1.5     32%
```

`cost_₽` = avg_in × calls × IN_PRICE + avg_out × calls × OUT_PRICE,
with prices read from env (`TIMEWEB_PRICE_IN_RUB_PER_M`,
`TIMEWEB_PRICE_OUT_RUB_PER_M`).

## Acceptance

After v0.3.1 lands:
- Re-run `node scripts/check-timeweb.js` probe 3 (`advise()`):
  expect `tokens_in` ≤ 300 (was ~800).
- Re-run probe 4 (auto-trigger flow): rationale still references the
  registered skill correctly.
- Run live for 1 hour, check `node scripts/list-improvements.js --stats`:
  per-trigger `avg_in` ≤ 300.
- Existing 360 tests still green; new prompt-builder tests cover the
  scoped registry behaviour.

## Out of scope (later versions)

- Tool/function-calling instead of free-form JSON (TimeWeb support unclear).
- Custom model selection per trigger (gpt-5.4-nano for routine repeats,
  gpt-5.4-mini for emergencies). Defer until cost/quality data points
  exist.
- Embedding-based prior-recommendation similarity check ("we already
  told the bot to tunnel-out at this exact wedge 10 minutes ago, skip").

## Implementation order

When this version is greenlit, work in this order on a single branch
`v0.3.1` (one PR per session, per recently-updated workflow memory):

1. P1 compact registry mode + prompt-builder test
2. P2 need-scoped registry (extend `runtime/manifesto/needs.js` with
   `relevantSkills`)
3. P3 snapshot pruning in `fast-advisor.js#buildUserPrompt`
4. P4 caching probe (one-off)
5. P5 cost telemetry in CLI viewer
6. STATUS.md + smoke retest + PR

All changes are additive; no behaviour regression expected. If
real-world after v0.3.1 shows the LLM giving worse advice with the
compact registry, fall back to default mode by flipping a single
constant in `fast-advisor.js`.
