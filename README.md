# pepa-pi-bot

> A universal, autonomous, self-extending Minecraft player. Powered by [Pi](https://pi.dev) and the [Mineflayer](https://github.com/PrismarineJS/mineflayer) protocol stack. Works against **any** Minecraft Java server — vanilla, Paper, Spigot, Fabric, Forge, online-mode or cracked, modded or vanilla.

The bot is **not a finished application**. It is a seed: a Pi agent with an initial mandate and a hand-off to whatever Minecraft server you point it at. From there, the agent is expected to grow its own toolset — writing new skills, fetching extensions, and adapting its behaviour as it plays.

The name `pepa-pi-bot` is just the project's name (`pepa` from the original test server, `pi` from the runtime). The bot itself is server-agnostic.

## Concept

Most Minecraft AI bots ship as monolithic projects: hard-coded actions, fixed prompts, a single LLM provider, sometimes a single target server. This repo flips that around.

```
┌───────────────────────────────────────────────┐
│  Pi (terminal agent, model-agnostic)          │
│  ├── AGENTS.md   ← generic mandate            │
│  ├── skills/     ← grown over time            │
│  └── extensions/ ← TS plugins, also grown     │
└───────────────┬───────────────────────────────┘
                │ spawns / controls
                ▼
┌───────────────────────────────────────────────┐
│  Mineflayer client                            │
│  - joins MC server as a real player           │
│  - chat, movement, inventory, world events    │
└───────────────┬───────────────────────────────┘
                │ TCP 25565
                ▼
┌───────────────────────────────────────────────┐
│  ANY Minecraft Java server                    │
│  configured via .env (host, port, auth, ...)  │
└───────────────────────────────────────────────┘
```

The Pi agent is the brain. Mineflayer is the body. The bridge between them — the skills, the prompt templates, the supervision loop — is meant to be written **by the agent itself**, starting from a minimal scaffold in this repo.

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
# 1. Clone
git clone git@github.com:xmatic-squad/pepa-pi-bot.git
cd pepa-pi-bot

# 2. Configure for your target server
cp .env.example .env
$EDITOR .env          # set MC_HOST, MC_USERNAME, auth mode, LLM provider, etc.

# 3. Install Node deps (mineflayer + dotenv to start)
npm install

# 4. Authenticate Pi with your LLM provider
pi /login             # OAuth flow — works with ChatGPT Pro / Claude Max
# OR
export OPENAI_API_KEY=sk-...
# OR
export ANTHROPIC_API_KEY=sk-ant-...

# 5. Launch the agent in this directory
pi
```

On first launch Pi loads `AGENTS.md` from the project root. That file is the seed prompt — it tells the agent it is a Minecraft player, where to find its configuration, and that it is expected to extend itself.

### Send the first message

Pi only acts when you write to it. Paste the [bootstrap prompt](./prompts/bootstrap.md) as the very first message:

```
You're awake. Read AGENTS.md and the repo's current state, then begin executing "First objective — bootstrap your own body" from AGENTS.md. Walk me through each step before you run it the first time — I want to see which Pi tooling (extensions API, skill API, plain bash, etc.) you choose for the mineflayer bridge.
```

The agent will then write `extensions/mineflayer-bridge.{ts,js}`, register it with Pi, handle whatever in-game login the server demands, send `hello`, and write its first skill at `skills/server-onboarding.md`.

Sessions persist by default. Use `pi -c` to resume the last conversation; subsequent sessions don't need the bootstrap prompt — a simple `Resume. Check the server's online, log in if needed, and report status.` is enough.

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
├── README.md           ← you are here
├── AGENTS.md           ← seed prompt, loaded by Pi on launch
├── .env.example        ← all required env vars, no secrets
├── .gitignore
├── LICENSE             ← MIT
├── package.json        ← node deps (mineflayer + dotenv to start)
├── skills/             ← grown by the agent (markdown skills)
├── extensions/         ← grown by the agent (typescript extensions)
├── prompts/            ← reusable prompt templates
└── docs/
    └── architecture.md ← longer-form design notes
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

🌳 **Bridge online.** The project-local Mineflayer bridge loads via `.pi/settings.json`, connects through the server's ViaVersion/ViaBackwards stack with an explicit supported client version from `.env`, registers `mc_chat`, `mc_position`, and `mc_disconnect`, handled first-join AuthMe-style registration, and sent `hello` in chat. First onboarding notes are captured in `skills/server-onboarding.md`.

## License

[MIT](./LICENSE) © [xmatic-squad](https://github.com/xmatic-squad)
