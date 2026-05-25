# Roadmap

> The bot grows by accretion. This file describes **the order in which it should grow**, not a set of features to build upfront. Each phase is something the agent itself can extend itself into, one skill at a time.

Status legend: 🌱 not started · 🌿 in progress · 🌳 done · ⏸️ paused

## Phase 0 — Body 🌳

The agent has a working Mineflayer bridge, joins the configured server, handles AuthMe-style first registration, sends chat, exposes `mc_chat / mc_position / mc_disconnect` to itself.

Captured in: `skills/server-onboarding.md`.

## Phase 1 — Presence 🌿

The bot is **on the server, all the time** (except for a clean human-issued disconnect), and is **conversational**:

- Listens to all chat, not only messages addressed by name.
- Replies to ambient conversation when it has something useful or amusing to add. Doesn't have to reply to everything — silence is fine; spam is not.
- Survives crashes: auto-reconnect on `kicked` / `end`, **bounded** (e.g. ≤ 3 reconnects in 10 minutes, then back off and wait — the server might genuinely be down).
- Stays put while connected: no wandering off, no PvP.

Stretch: short-term chat memory (last N lines) so it can reference what was just said.

## Phase 2 — Locomotion with guard rails 🌱

The bot can be **summoned** by chat: "come to 100 64 -200", "follow me", "go to spawn". With three hard rails:

- **Distance bound.** Refuse trips longer than `MAX_TRAVEL_BLOCKS` (e.g. 500 blocks straight-line) from current position. Politely explain why.
- **Focus.** While moving toward a target, ignore competing summons. Reply once with "currently on my way to X, will be free in ~N seconds." Don't context-switch mid-trip.
- **Safety pathing.** Wrap `mineflayer-pathfinder` so the bot doesn't drop into lava, into the void, or into player-claimed regions.

Stretch: `mc_position_share()` so the bot can answer "where are you?".

## Phase 3 — Best life when idle 🌱

When chat is quiet for some threshold (e.g. 10 minutes of no addressed/non-trivial messages), the bot switches to **autonomous mode**:

- Builds a small base somewhere safe, away from player builds.
- Farms (wood, food, basic resources). Stores in chests at the base.
- Explores cautiously — no caves without torches, no nether yet.
- Logs what it did into `state/<host>/diary/YYYY-MM-DD.md`.
- Drops back into "presence" mode the moment a human says something.

This is where the agent should be most prolific in writing new skills (`farming-wheat`, `chest-organizer`, `careful-cave-mining`, etc.).

## Phase 4 — Telegram bridge 🌱

Two-way ops channel without sitting in Pi TUI:

- Operator sends a message in Telegram → bot reads, responds in Telegram (not MC chat).
- Bot can push notifications to Telegram: escalations, errors, "I just built a thing", milestones.
- Per-`chat_id` whitelist (only configured chat IDs are trusted).

`.env` placeholders for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OPERATOR_CHAT_ID` already exist.

## Phase 5 — Self-extension as default 🌱

By this phase the patterns above should produce a reflex:

- A human says "do X" the bot doesn't know how to do →
- Bot replies "I'll try to learn", drafts a skill plan,
- Either executes it directly (if safe + within rate limits) or commits the skill draft to `skills/` for human review.

The first successful "I'll try to learn" cycle that ships a useful skill marks Phase 5 as 🌳.

## Phase 6 — Escalation log 🌱

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
