# Runtime — hybrid script + LLM-on-demand

> Status: **active**. This is the recommended way to run pepa-pi-bot since
> 2026-05-25. The pure Pi runtime (`pi` from repo root) still works and is
> documented as a fallback at the bottom of this file.

## Why a hybrid runtime?

The original design ran every tick inside Pi — the LLM saw the world, picked
one tool, executed it, looped. That gave full self-extension out of the box,
but had three problems in practice:

1. **Slow.** A "look around → defend yourself" round-trip took 20–60 seconds
   because the LLM was in the hot path.
2. **Expensive.** Hostile mob at 4 m? Cost of evasion = one full reasoning
   pass. Hungry? Same. Idle? Same.
3. **Invisible.** With Pi as the only frontend, you had to `tmux capture-pane`
   to know what the bot was doing.

The hybrid runtime splits the bot into a script-driven layer that handles
fast, well-understood things on its own, and a Pi (or Codex) headless
escalation that's only invoked when the script gets stuck or needs to write
new code for itself.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  operator                                                          │
│  ├── repo edits (.env, skills/, runtime/)                          │
│  ├── TUI (Ink) — see status, send chat, press [a] to escalate      │
│  └── (future) Telegram bridge                                      │
└─────────────┬────────────────────────────────────────────┬─────────┘
              │ Unix socket (newline-JSON)                 │ git
              ▼                                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  runtime/bot.js — single long-running Node process                 │
│                                                                    │
│  ┌──────────────────┐  ┌──────────────────────┐  ┌────────────────┐│
│  │ Mineflayer       │  │ Reflex loop          │  │ IPC server     ││
│  │ - MC TCP         │  │ - tick every N sec   │  │ - Unix socket  ││
│  │ - AuthMe handler │◀─│ - priority order:    │─▶│ - broadcasts   ││
│  │ - chat / events  │  │   defend > eat       │  │   status/log/  ││
│  │                  │  │   > sleep > current  │  │   chat events  ││
│  │                  │  │   > idle             │  │ - accepts      ││
│  │                  │  │ - NO LLM in path     │  │   commands     ││
│  └──────────────────┘  └─────────┬────────────┘  └────────────────┘│
│                                  │                                 │
│                                  ▼ on stuck / new scenario         │
│                        ┌──────────────────────┐                    │
│                        │ pi-bridge.js         │                    │
│                        │ spawn `pi -p`        │                    │
│                        │ stream stdout to IPC │                    │
│                        └──────────────────────┘                    │
└────────────────────────────────────────────────────────────────────┘
              │
              │ TCP 25565
              ▼
       Minecraft server
```

The bot is **one process**. The TUI is a separate process you can connect and
disconnect at will — the bot keeps running. Multiple TUI clients can attach
to the same bot simultaneously.

## Quickstart

```bash
# Once
cd ~/Projects/pepa-pi-bot
npm install

# Terminal 1 — the bot daemon
npm run bot
# Logs go to stdout AND state/<host>/logs/<YYYY-MM-DD>.log

# Terminal 2 — the dashboard
npm run tui
```

The TUI auto-reconnects to the bot if you restart it. Press `q` to leave the
TUI; the bot is unaffected.

## TUI hotkeys

| Key | Effect |
|-----|--------|
| `p` | Pause / resume the reflex loop (MC connection stays). |
| `s` | Stop the bot process gracefully (disconnect + cleanup + exit). |
| `r` | Force-broadcast a status snapshot now. |
| `c` | Enter **chat mode** — type a message, Enter sends it into MC chat. |
| `a` | Enter **ask-Pi mode** — type a prompt, Enter spawns `pi -p` and streams output into the Pi panel. |
| `y` | Open the latest pending proposal. In the proposal panel: `y` approves, `n`/Esc closes. |
| `q` | Quit TUI only. Bot keeps running. |

`Enter` submits, blank submit cancels. The status bar shows `[proposals N, press y]` when there's something pending.

## What the reflex loop does today

The chain (highest priority first), wired and dispatching real
Mineflayer actions:

1. **`operatorGoalReflex`** — if `OPERATOR_USERNAMES` issued a `come` /
   `follow` command, satisfy it (walk to the operator's last known
   position, reply in chat on arrival or failure).
2. **`defendReflex`** — closest hostile within 4 m → `attackNearest`
   (equips best melee). Within 12 m + low HP or ≥3 hostiles → `fleeFrom`
   along the away-vector.
3. **`eatReflex`** — food < 16 → `eatBestFood` (picks from
   FOOD_PRIORITY list, equip + consume). 5 s cooldown.
4. **`sleepReflex`** — night + no hostile within 8 m → `sleepInBed`
   (finds nearest placed bed within 16 blocks, paths there, sleeps).
   30 s cooldown on failures.
5. **`idleReflex`** — every 20th tick, log heartbeat (HP / food / pos).

Adding a new reflex = a function `(ctx) => { action, ... }` in
`runtime/reflex.js`, inserted at the right priority. Actions live in
`runtime/actions.js`. Both files trigger a supervisor hot-restart when
saved (see "Self-improvement" below).

## When the bot calls Pi

Two escalation paths:

**1. Manual** — operator presses `a` in the TUI, types a question, the
bot spawns `pi -p "<question>"` and streams its stdout into the Pi
panel.

**2. Automatic** — every tick where the entire reflex chain returns
`noop` (no operator goal, no hostiles in reach, food fine, day or no
bed, etc.) increments a counter. When the counter hits
`ESCALATE_AFTER_NOOPS = 20` (≈1 min at `tick=3s`), the bot fires
`askPi` with the current snapshot and a fixed system prompt telling Pi
to suggest one next action. 10 min cooldown so a permanently-idle bot
doesn't run the LLM dry.

The auto-escalation prompt explicitly bans code-change proposals — Pi
should only suggest what to do *with the existing tools*. If a deeper
problem is happening, the failure-tracker (see Self-improvement) will
file a proposal instead.

## Operator chat commands

Players listed in `OPERATOR_USERNAMES` can address the bot in MC chat
by prefixing the message with the bot's name:

```
pepa_bot status      → bot replies with HP / food / pos / hostiles / busy
pepa_bot come        → bot pathfinds to the operator's current position
pepa_bot pause       → reflex loop stops
pepa_bot resume      → reflex loop resumes
pepa_bot stop        → graceful disconnect + process exit
```

Unrecognized commands get a polite "didn't recognize" reply. Operator
identity verification is the server's job (AuthMe on cracked,
online-mode on premium) — the bot trusts the nickname.

## IPC protocol

Socket: `state/<MC_HOST>_<MC_PORT>/bot.sock` (permissions 0600, removed on
shutdown). Framing: one JSON object per line.

**Server → client events** (see `runtime/ipc-protocol.js`):

| Type | Payload |
|------|---------|
| `hello` | `{ snapshot, recentLogs }` — sent on connect. |
| `status` | full snapshot from `perceive.js`. |
| `log` | `{ ts, level, source, text, details }` — every log line. |
| `chat` | `{ from, text, kind: "player" \| "system" }`. |
| `death` | `{ reason, position }`. |
| `error` | `{ source, text }`. |
| `ask-pi-chunk` | `{ stream: "stdout" \| "stderr", text }`. |
| `ask-pi-done` | `{ code, durationMs }`. |

**Client → server commands:**

| Type | Payload | Effect |
|------|---------|--------|
| `cmd:pause` | `{}` | Reflex loop stops ticking. |
| `cmd:resume` | `{}` | Reflex loop resumes. |
| `cmd:stop` | `{}` | Graceful shutdown of the bot. |
| `cmd:chat` | `{ text }` | Sends text into MC chat (rate-limited). |
| `cmd:ask-pi` | `{ prompt }` | Spawns `pi -p "<prompt>"`. |
| `cmd:snapshot` | `{}` | Force a `status` event now. |

The protocol is intentionally tiny — anyone can write a second client
(a Telegram bridge, a web UI, a one-shot CLI) by reading
`runtime/ipc-protocol.js`.

## Self-improvement loop (fully autonomous)

End-to-end, no operator-in-the-loop. The bot writes proposals when it
spots a *real* bug, applies them with Pi headless, and rolls them back
if they break things. The flow:

```
1. reflex dispatches action → action returns { ok: false, detail }
2. bot.js failure tracker classifies the detail:
     bug          → TypeError / Cannot read / is not defined …
     timeout      → "timed out after Ns"
     feature-gap  → "no reachable log", "no food", "no bed" …
     other        → anything else
3. 5 consecutive failures with the SAME label, where the run is dominated
   by 'bug' or all 'timeout' → writeProposal()
   (feature gaps are SKIPPED — reflex routing solves those, not the LLM)
4. runtime/auto-improve.js watcher (poll 2s) sees the new file,
   debounces 10s, then spawns scripts/auto-patch.js detached
5. auto-patch.js:
     - refuses on dirty tree
     - moves proposal pending → approved/ (audit trail)
     - creates branch auto/<slug> off main
     - runs `pi -p "<patch prompt>"` with 10-min timeout
     - if Pi committed AND only touched runtime/ → cherry-pick onto main
     - else → discard branch, exit non-zero
6. supervisor's runtime/*.js watcher fires the moment the cherry-pick
   lands → child restarts on the new code
7. if the new code crashes >5 times in 60s AND the last commit on main
   is younger than 15 min AND it touched runtime/ → supervisor
   `git reset --hard HEAD~1` and restarts. Up to MAX_ROLLBACKS times
   per supervisor lifetime, then bails out for manual investigation.
```

### Rate limits

- **Proposal cooldown**: 30 min between proposal files of any kind.
- **Auto-improve cooldown**: 15 min between finished `auto-patch.js` runs.
- **Hourly cap**: max 4 auto-patches per hour, even if cooldown allows.
- **Rollback cap**: 3 rollbacks per supervisor lifetime; after that the
  supervisor exits and waits for human review.

### What counts as a bug

`runtime/bot.js` ships two whitelists (`NORMAL_FAILURE_SUBSTRINGS` and
`BUG_FAILURE_SUBSTRINGS`). The proposal trigger fires only when:
- the trailing run of same-label failures contains at least one bug
  (TypeError / ReferenceError / "Cannot read properties" / etc.),
- OR every failure in the run is a timeout (and they happened on the
  same operation, so it's probably broken not just unreachable).

Feature gaps like "no reachable log within 32 blocks" are *not* a bug
— the autonomous reflex sees that result, sets `noTreesUntil` and
switches to wander. If the script can't solve it via reflex routing,
that's a design issue the operator fixes by editing `runtime/reflex.js`
directly — not by asking Pi to patch around it.

### Manual escape hatches

These still work but should rarely be needed:
- TUI hotkey `y` opens the latest pending proposal for inspection.
- `npm run propose:apply <filename>` runs the *attended* version of the
  patcher — leaves the result on a `feat/proposal-<slug>` branch
  without cherry-picking, so the operator can review the diff manually.
- `npm run stop` kills everything and clears lock/socket.

## File layout

```
runtime/
  supervisor.js       forks bot.js, watches runtime/*.js, restart-on-change
  bot.js              entrypoint — owns MC + tick + IPC + reconnect
  config.js           reads .env, exposes frozen config + redacted view
  log.js              ring buffer + stdout + daily file + IPC fan-out
  perceive.js         snapshot(bot) → JSON
  reflex.js           priority chain (operator > defend > eat > sleep > idle)
  actions.js          attackNearest / fleeFrom / eatBestFood / sleepInBed / goTo
  state-store.js      current-task / diary / proposals on disk
  ipc-server.js       Unix-socket server
  ipc-protocol.js     shared contract (event types, command types, framer)
  pi-bridge.js        spawn `pi -p`, stream stdout

tui/
  tui.tsx             Ink dashboard (React)
  ipc-client.js       socket client → EventEmitter

scripts/
  propose-apply.js    approved-proposal → feat-branch + `pi -p` patcher
```

Per-server state stays under `state/<MC_HOST>_<MC_PORT>/`, gitignored:

```
state/play.xmatic.team_25565/
  bot.sock                   Unix-domain socket (perms 0600, ephemeral)
  joined-before.flag         AuthMe /register vs /login marker
  current-task.json          resume anchor — what the bot was doing
  goal.md                    long-term ambition (operator-seeded)
  diary/YYYY-MM-DD.md        daily journal (one line per milestone)
  proposals/                 pending self-improvement proposals
  proposals/approved/        approved, waiting on propose:apply
  logs/YYYY-MM-DD.log        full runtime log mirror
```

## Pi-only fallback

The original Pi-driven runtime still works if you prefer the single-process
model — `npm run agent` from repo root loads `AGENTS.md` and the existing
extensions in `extensions/`. The two runtimes share the `.env`, the
`mineflayer` deps, and the `state/` directory. They MUST NOT run
simultaneously — both will try to claim the same MC nickname and the
server will kick one of them.

If you switch between them frequently, kill one before starting the other:

```bash
# stop hybrid
# (in TUI press 's', or just kill `npm run bot`)

# start Pi
npm run agent
```
