# Roadmap

> The bot grows by accretion. This file describes **the order in which it should grow**, not a set of features to build upfront. Each phase is something the agent itself can extend itself into, one skill at a time.

> **Product pivot (2026-05-25).** The original roadmap below assumed an
> operator-driven bot (chat summons, follow-me, etc.). The new direction is
> an autonomous survival resident — see `plans/autonomous-survival-bot-prd.md`
> for the active plan and phase structure. Where the two disagree, **the PRD
> wins.** Phases 2 (chat-summons) and 3 (operator-priority loop) below are
> kept as historical context but no longer represent shipping work; the new
> phases are tracked in the PRD.

Status legend: 🌱 not started · 🌿 in progress · 🌳 done · ⏸️ paused

## Phase 0 — Body 🌳

The agent has a working Mineflayer bridge, joins the configured server, handles AuthMe-style first registration, sends chat, exposes `mc_chat / mc_position / mc_disconnect` to itself.

Captured in: `skills/server-onboarding.md`.

## Phase 1 — Presence 🌳

The bot is **on the server, all the time** (except for a clean human-issued disconnect), and is **conversational**:

- Listens to all chat, not only messages addressed by name.
- Replies to ambient conversation when it has something useful or amusing to add. Doesn't have to reply to everything — silence is fine; spam is not.
- Survives crashes: auto-reconnect on `kicked` / `end`, **bounded** (e.g. ≤ 3 reconnects in 10 minutes, then back off and wait — the server might genuinely be down).
- Stays put while connected: no wandering off, no PvP.

Stretch: short-term chat memory (last N lines) so it can reference what was just said.

## Phase 2 — Locomotion with guard rails ⏸️ (superseded by PRD)

> Historical scope: chat-driven summons. As of the 2026-05-25 pivot, MC chat
> cannot summon the bot. Pathfinder/safety primitives from this phase are
> still useful for autonomous survival movement; the chat-driven summon
> surface is removed. See PRD §5 (Target Architecture).

The bot can be **summoned** by trusted/sanctioned coordinate requests via `mc_goto`; dynamic follow is still pending. Goal: "come to 100 64 -200", "follow me", "go to spawn" with three hard rails:

- **Distance bound.** Refuse trips longer than `MAX_TRAVEL_BLOCKS` (e.g. 500 blocks straight-line) from current position. Politely explain why.
- **Focus.** While moving toward a target, ignore competing summons. Reply once with "currently on my way to X, will be free in ~N seconds." Don't context-switch mid-trip.
- **Safety pathing.** Wrap `mineflayer-pathfinder` so the bot doesn't drop into lava, into the void, or into player-claimed regions.

Stretch: `mc_position_share()` so the bot can answer "where are you?".

## Phase 3 — Best life when idle / goal-driven autonomy 🌿 (revised by PRD)

> The "live operator task → drop everything" step from the legacy priority
> loop no longer applies — MC chat cannot create tasks. The revised
> scheduler priority lives in PRD §5.3 (Task Scheduler Priority). The rest
> of this section (goal/plan/current-task/diary structure) still applies
> and is the foundation for the survival curriculum.

The bot is **always autonomous**: it does not wait for operator chat to
have something to do.

- A long-term goal lives in `state/<MC_HOST>/goal.md`. Personal memory, see `docs/memory-model.md`.
- Decomposed into milestones in `state/<MC_HOST>/plan.md`.
- Current action is checkpointed in `state/<MC_HOST>/current-task.json` for resume-on-restart.
- Daily journal in `state/<MC_HOST>/diary/YYYY-MM-DD.md`.

Revised priority loop (per PRD §5.3):
1. Emergency survival (death/lava/low HP/starvation).
2. Finish or recover current task.
3. Maintain base safety (light, shelter, repair).
4. Execute current milestone.
5. Expand village/base.
6. Social reply if there is a relevant chat event.
7. Idle diary/status heartbeat.

Concrete activities while autonomous: scout/build modest base, farm food, store in chests, light area, defend at night, explore cautiously, build out toward the goal. Skills emerge: `farming-wheat`, `chest-organizer`, `careful-cave-mining`, `village-layout`, etc.

## Phase 4 — Telegram bridge 🌱

Two-way ops channel without sitting in Pi TUI:

- Operator sends a message in Telegram → bot reads, responds in Telegram (not MC chat).
- Bot can push notifications to Telegram: escalations, errors, "I just built a thing", milestones.
- Per-`chat_id` whitelist (only configured chat IDs are trusted).

`.env` placeholders for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OPERATOR_CHAT_ID` already exist.

## Phase 5 — Self-extension as default 🌿

By this phase the patterns above should produce a reflex:

- A human says "do X" the bot doesn't know how to do →
- Bot replies "I'll try to learn", drafts a skill plan,
- Either executes it directly (if safe + within rate limits) or commits the skill draft to `skills/` for human review.

The first successful "I'll try to learn" cycle that ships a useful skill marks Phase 5 as 🌳.

## Phase 6 — Escalation log 🌳

When a request smells destructive, ambiguous, or off-policy (e.g. break a player's blocks, leave a structure, give someone an item from inventory, leave the server entirely), the bot doesn't unilaterally do it and doesn't flatly refuse. Instead:

1. **In chat**, brief reply: "Не уверен про это, отметил для оператора."
2. **In `state/<host>/escalations.jsonl`**, one JSON line per event: timestamp, requester, request text, classification, what the bot would have done.
3. **At next Pi session start** (and once Telegram exists, immediately), surface a count: "N pending escalations since last session".

The operator either turns the request into a sanctioned skill (and merges it) or leaves it logged. Either way, the bot learns where its own boundaries actually are.

---

## Non-goals (for now)

- **PvP / griefing tools** — never.
- **Anything requiring OP** — never. If a skill seems to need OP, that's a sign it doesn't belong on this bot.
- **Cross-server identity** — phase 3 diaries are per-server (`state/<host>/...`). Same skill set, separate memories.
- **Multiple bot instances at once** — one bridge, one bot, one server per `pi` process. Multi-bot is a different project.
