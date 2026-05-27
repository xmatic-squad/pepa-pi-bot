# pepa-pi-bot

> A universal, autonomous, **self-extending** Minecraft player. Built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) with a hybrid runtime: a fast script-driven reflex loop for the everyday, headless [Pi](https://pi.dev) escalation for the hard bits, and a **git-as-evolution-substrate** loop where the bot writes its own new skills and cherry-picks them onto `main` after passing a real `npm test` smoke gate. Works against **any** Minecraft Java server — vanilla, Paper, Spigot, Fabric, Forge, online-mode or cracked, modded or vanilla.

The bot is **not a finished application**. It is a seed: a Mineflayer body, a tiny reflex brain, persistent memory (`world-journal`, `scenario-memory`), a Voyager-style critic + Mindcraft-style modes/skill-library, and a self-improvement loop. The bot is expected to grow its own toolset over time — writing new reflexes, installing skills, adapting its behaviour as it plays.

**Related work**: conceptually close to [Voyager](https://github.com/MineDojo/Voyager) (NVIDIA, GPT-4) and [Mindcraft](https://github.com/mindcraft-bots/mindcraft) (multi-agent LLM framework). The differentiator is that pepa stores its growing skill library as **versioned source code on `main`**, not as JSON in RAM — every Pi-written skill goes through `git checkout -b → npm test → cherry-pick`, making the loop auditable and rollback-safe.

The name `pepa-pi-bot` is just the project's name (`pepa` from the original test server, `pi` from the original runtime). The bot itself is server-agnostic.

## Runtime modes

Two ways to run the bot. The hybrid runtime is the default — Pi-only is a fallback for experiments.

| Mode | Entry | When to use |
|---|---|---|
| **Hybrid runtime** (recommended) | `npm run bot` + `npm run tui` | Day-to-day. Script-driven reflex tick + Ink TUI dashboard + Pi/Codex called only on demand. Fast, cheap, observable. |
| **Pi-only** (fallback) | `npm run agent` | When you want every decision to go through an LLM (rare, but useful for experiments and code-writing sessions). |

See [`docs/runtime.md`](./docs/runtime.md) for the full hybrid runtime guide, IPC protocol, TUI hotkeys, and the self-improvement loop.

## Concept

Most Minecraft AI bots ship as monolithic projects: hard-coded actions, fixed prompts, a single LLM provider, sometimes a single target server. This repo flips that around with a layered runtime.

```
┌──────────────────────────────────────────────────────────┐
│  TUI (Ink) — operator dashboard, attaches via Unix sock  │
│  status / live log / MC chat / hotkeys / ask-Pi          │
└──────────────────────┬───────────────────────────────────┘
                       │ newline-JSON
                       ▼
┌──────────────────────────────────────────────────────────┐
│  runtime/bot.js — long-running Node daemon               │
│  ├── Mineflayer client (MC TCP, AuthMe, chat, events)    │
│  ├── Modes chain (self_preservation > hunger > shelter)  │
│  │   priority interrupts before curriculum dispatch      │
│  ├── Reflex loop (defend > eat > sleep > curriculum)     │
│  │   pure script — no LLM in the hot path                │
│  ├── perception.js — numeric-id findBlocks (VB-safe)     │
│  ├── world-journal + scenario-memory (persistent JSONL)  │
│  ├── stuck-incident → critic (Pi) → proposal             │
│  ├── auto-improve → auto-patch → npm test → cherry-pick  │
│  ├── social/conversation — file-JSONL multi-agent topics │
│  └── pi-bridge — spawn `pi -p` only on demand            │
└──────────────────────┬───────────────────────────────────┘
                       │ TCP 25565 (any host/port)
                       ▼
        ANY Minecraft Java server (configured in .env)
```

The reflex loop is the brain stem. Pi is the cortex — called only when the reflex loop is genuinely stuck, or when the operator asks for help via the TUI. Mineflayer is the body. The skills, reflexes, and supervision loop are meant to grow over time — both by hand and by the bot itself proposing patches.

## Prerequisites

| Tool | Why | How to get it |
|---|---|---|
| **Pi** ≥ `0.75` | The agent runtime. Reads `AGENTS.md`, loads skills, calls the LLM. | `curl -fsSL https://pi.dev/install.sh \| sh` |
| **Node.js** ≥ `20` | Required by Pi and by Mineflayer. | `brew install node` / `nvm install 20` |
| **An LLM credential** | One of: OpenAI / Anthropic / Google API key, or an OAuth-authenticated subscription (`/login` inside Pi). ChatGPT Pro and Claude Max work via OAuth on supported providers. | See [Authentication](#authentication) |
| **Access to some Minecraft server** | The bot joins as a real player. Cracked or premium, online-mode or offline, doesn't matter — configure it in `.env`. | — |
| **Network access to that server** | Direct TCP to `host:port`. | — |

> The bot does **not** need its own Minecraft client install, server admin access, RCON, or any server-side plugin. It joins as a vanilla player over the standard protocol.

## Quickstart

```bash
# 1. Clone + configure
git clone git@github.com:xmatic-squad/pepa-pi-bot.git
cd pepa-pi-bot
cp .env.example .env
$EDITOR .env          # set MC_HOST, MC_USERNAME, auth mode, AuthMe password, etc.

# 2. Install Node deps
npm install

# 3. (Optional) Authenticate Pi for the escalation hotkey
pi /login             # OAuth flow — ChatGPT Pro / Claude Max
# or export OPENAI_API_KEY / ANTHROPIC_API_KEY

# 4. Run the bot — two terminals
#    Terminal 1: the daemon (logs in stdout, persists state under state/<host>/)
npm run bot

#    Terminal 2: the dashboard (Ink TUI). Hotkeys: p/s/r/c/a/k/v/!/y/q.
npm run tui
```

The TUI auto-reconnects to the bot if you restart it. Press `q` to leave the TUI; the bot keeps running.

> Want the LLM-driven, single-process flavour? `npm run agent` launches the original Pi runtime instead. See [`docs/runtime.md`](./docs/runtime.md) for the trade-offs.

### Sending chat or asking Pi from the TUI

- Press **`c`** in the TUI to enter chat mode — type, Enter sends into MC chat (rate-limited per `.env`).
- Press **`a`** to enter ask-Pi mode — type a prompt, Enter spawns `pi -p "<prompt>"`. Output streams into the Pi panel without leaving the TUI.

### TUI hotkeys cheatsheet

| Key | Effect |
|---|---|
| `p` | Pause / resume the reflex loop (MC connection stays). |
| `s` | Stop the bot (graceful disconnect + cleanup). |
| `r` | Force a fresh status snapshot. |
| `c` | Send a chat message into MC. |
| `a` | Ask Pi (one-shot subprocess). |
| `k` | Run one registered skill with optional JSON args. |
| `v` | Capture a viewer screenshot for debugging. |
| `!` | Force a critic-backed incident/proposal. |
| `y` | Open the latest pending proposal (badge appears in status bar). In the panel: `y` approve, `n`/Esc close. |
| `q` | Quit the TUI — bot keeps running. |

### Self-improvement loop (short version)

The bot **proposes its own patches** when something repeatedly fails:

1. Reflex action fails 3× with the same label → markdown proposal lands under `state/<host>/proposals/`.
2. Status bar shows `[proposals N, press y]`.
3. Press `y` to read, `y` to approve. The proposal moves to `proposals/approved/`.
4. Run `npm run propose:apply <filename>` — spawns Pi headless on a fresh feature branch with the proposal + repo conventions. Pi writes a patch and commits.
5. Review the diff, smoke-test locally (`npm run bot`), push + open a PR by hand.

Supervisor (`npm run bot`) watches `runtime/*.js` and hot-restarts the child on file change, so during step 4 you can iterate quickly.

See [`docs/runtime.md`](./docs/runtime.md) for the full lifecycle. **Note (2026-05-25):** MC chat is now dialog-only — operator commands (`come`, `pause`, `stop`, …) are no longer dispatched from chat; use the TUI for local control. See `plans/autonomous-survival-bot-prd.md` for the survival-bot pivot.

## Authentication

Two dimensions:

**1. Minecraft auth.** Configured in `.env` via `MC_AUTH_MODE`:
- `offline` — cracked servers. Any nickname works. No external auth call.
- `microsoft` — premium / online-mode servers. Mineflayer handles the device-code flow on first connect and caches the token in `~/.minecraft-auth/`.

**2. LLM auth.** Pi supports **15+ providers** and two credential modes:
- **OAuth subscription login** — `pi` then `/login` inside the TUI. Suitable for ChatGPT Plus/Pro, Claude Max, and other subscriptions that ship an OAuth flow. No metered API billing.
- **API key environment variables** — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc. Metered, but no UI prompt.

You can mix providers via `--provider openai --model gpt-5` at launch — cheaper models for idle ticks, smarter ones for hard decisions.

## How the agent extends itself

Pi has first-class support for three growth surfaces:

- **`skills/`** — Markdown-defined capabilities Pi can invoke. The agent can `Write` new ones at runtime when it discovers a missing capability.
- **`extensions/`** — TypeScript modules registering new tools, commands, or UI tweaks. Installed project-locally via `pi install -l npm:<pkg>` / `pi install -l git:<url>`, or written in-tree.
- **`prompts/`** — Reusable prompt templates. Useful for cron-driven tick prompts ("what should I do next minute?").

The opening `AGENTS.md` instructs the agent to start by writing a `mineflayer-bridge` extension that can:
- connect to the configured MC server (any host/port/version)
- handle the configured auth mode (offline or microsoft)
- if a login plugin like AuthMe is present, perform `/register` and `/login` from a password supplied in `.env`
- emit world events back into the agent loop
- expose `chat / move / dig / place / equip / attack` as Pi tools

Everything beyond that — farming, exploration, base-building, player interaction, server-specific quirks — should emerge from the agent itself.

### Everything in the repo

A hard rule, mirrored in `AGENTS.md`: every artefact the agent produces **lives in this repo**, never in the user's `~/.pi/` directory. That includes skills, extensions, prompt templates, project Pi settings (`.pi/settings.json`), and per-server state (`state/<MC_HOST>/`).

The point is reproducibility and **community growth**: a fresh `git clone` should bring along every skill any contributor has written. Pi's own built-in skills (`skill-creator`, `agent-browser`, etc.) stay user-global — the agent is allowed to *use* them, but anything it *authors* lands under `./skills/` or `./extensions/` here.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the skill format and how to propose changes.

## Project layout

```
pepa-pi-bot/
├── README.md             ← you are here
├── AGENTS.md             ← seed prompt, loaded by the Pi-only runtime
├── .env.example          ← all required env vars, no secrets
├── package.json          ← node deps + scripts (`bot`, `tui`, `agent`)
├── runtime/              ← hybrid runtime (script reflex + IPC server)
│   ├── bot.js                  long-running Mineflayer daemon
│   ├── reflex.js               priority-ordered behaviours, no LLM
│   ├── perceive.js             snapshot builder
│   ├── ipc-server.js           Unix-socket server
│   ├── ipc-protocol.js         shared IPC contract
│   └── pi-bridge.js            spawn `pi -p` on demand
├── tui/                  ← Ink TUI dashboard
│   ├── tui.tsx
│   └── ipc-client.js
├── skills/               ← markdown skills (grown by bot or operator)
├── extensions/           ← Pi extensions (mindcraft-skills, mineflayer-bridge)
├── prompts/              ← reusable prompt templates
└── docs/
    ├── runtime.md            hybrid runtime guide (start here)
    ├── architecture.md       longer-form design notes
    ├── memory-model.md       per-server state layout
    ├── roadmap.md            phased plan
    └── …
```

## Safety boundaries

Server-agnostic but with hard defaults the agent must respect on any server it joins:

- **Never request OP / admin rights** in chat.
- **Never break or modify other players' builds** without explicit human request.
- **Never spam chat** — built-in rate limit (`CHAT_RATE_LIMIT_PER_MIN` in `.env`).
- **Never leak secrets** from `.env` (auth passwords, API keys) into chat, world signs, books, commits, or web fetches.
- **No destructive bash** in the repo (`rm -rf`, force pushes) without operator confirmation.
- **Stop and wait** if kicked or banned — do not auto-reconnect indefinitely.

These are mirrored in `AGENTS.md` and re-stated at the top of any system prompt that overrides it.

## Status

🌳 **Phase 0 — Body** done. Bridge online, AuthMe handled, `hello` sent. See `skills/server-onboarding.md`.

🌳 **Phase 1 — Presence** implemented: bridge stays online with bounded reconnects, rolling chat buffer, status/recent-chat tools, sparing replies.

🌿 **Phase 2 — Locomotion/build rails** in progress: `mineflayer-pathfinder` is wired with guarded `mc_goto`, plus `mc_build_pyramid_5x5`. Phase 5 self-extension and Phase 6 escalation logging are implemented.

🌱 **Phase 3 — Goal-driven autonomy** seeded: [`docs/memory-model.md`](./docs/memory-model.md) defines shared-knowledge vs personal-memory; per-server `goal.md` / `plan.md` / `current-task.json` / `diary/` shape autonomous behaviour.

🌿 **Survival-bot pivot (2026-05-25)** — the bot is becoming a self-sufficient survival resident of the configured server. **MC chat is dialog-only**; operator/player chat commands are recorded but not dispatched (TUI is the only local control plane). The hybrid runtime now has enriched perception, priority modes, a skill-driven curriculum, food acquisition, bed/sleep, base/chest/shelter/farm skills, persistent skill metrics, scenario memory, and a scoped auto-patch loop with `npm test` smoke gating. Full plan: `plans/autonomous-survival-bot-prd.md` (local-only, gitignored).

Full plan: [`docs/roadmap.md`](./docs/roadmap.md). Memory layout: [`docs/memory-model.md`](./docs/memory-model.md). Day-to-day judgement: "Operating principles" in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE) © [xmatic-squad](https://github.com/xmatic-squad)
