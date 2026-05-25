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
| `q` | Quit TUI only. Bot keeps running. |

`Enter` submits, blank submit cancels.

## What the reflex loop does today

All reflex bodies are currently **stubs** — they log decisions but don't yet
call into Mineflayer actions. The priority chain is wired:

1. `defendReflex` — closest hostile within 6 m → log + decision (next:
   actually attack / flee).
2. `eatReflex` — food ≤ 16 → log (next: equip food, eat).
3. `sleepReflex` — night + bed in inventory → log (next: `bot.sleep`).
4. `idleReflex` — every 10th tick, log heartbeat (HP / food / pos).

Adding a new reflex = a function `(ctx) => { action, ... }` in
`runtime/reflex.js`, inserted at the right priority. Pure script, no LLM.

## When the bot calls Pi

Reflexes that don't handle a situation simply return `noop`. After N
consecutive tick cycles with no useful action — or when a reflex explicitly
flags "stuck" — the bot will escalate by calling `pi-bridge.js`:

```js
askPi({
  prompt: "I've been at the same position for 5 minutes, last reflex chain
  fell through, snapshot attached. What's a reasonable next action?",
  onChunk, onDone,
});
```

This is **not wired into the reflex loop yet** — the escalation is currently
operator-driven via TUI hotkey `a`. Wiring it up as an automatic fallback is
the next milestone.

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

## Self-improvement loop (planned)

When a reflex repeatedly fails (e.g. "tried to navigate to base 3 times,
pathfinder returned noPath each time"), the bot will:

1. Write `state/<host>/proposals/YYYY-MM-DD-<slug>.md` describing the gap.
2. Mark a flag in the next `status` event so the TUI surfaces it.
3. Wait for operator approval (TUI key `y` on a proposal — not yet built).
4. On approval: spawn Pi headless with the proposal text + repo context, ask
   it to write a new skill / patch, commit on a feature-branch.
5. Hot-reload the affected module (reflex / actions) without dropping the MC
   connection.

This is the "bot writes its own code, asks permission, restarts itself"
loop — the whole point of having Pi as an escalation rather than a runtime.
Not wired yet; tracked under tasks #56–#58 history.

## File layout

```
runtime/
  bot.js              entrypoint — owns MC + tick + IPC + reconnect
  config.js           reads .env, exposes frozen config + redacted view
  log.js              ring buffer + stdout + daily file + IPC fan-out
  perceive.js         snapshot(bot) → JSON
  reflex.js           priority chain (defend / eat / sleep / idle, stubs)
  ipc-server.js       Unix-socket server
  ipc-protocol.js     shared contract (event types, command types, framer)
  pi-bridge.js        spawn `pi -p`, stream stdout

tui/
  tui.tsx             Ink dashboard (React)
  ipc-client.js       socket client → EventEmitter
```

Per-server state stays under `state/<MC_HOST>_<MC_PORT>/`, gitignored, same
as before. The `bot.sock` lives there too.

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
