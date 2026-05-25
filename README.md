# pepa-pi-bot

> An autonomous self-extending Minecraft player, powered by [Pi](https://pi.dev) and the [Mineflayer](https://github.com/PrismarineJS/mineflayer) protocol stack. Built for the [pepa](https://mc.xmatic.team) survival server.

The bot is **not a finished application**. It is a seed: a Pi agent with an initial mandate and a hand-off to a Minecraft server. From there, the agent is expected to grow its own toolset — writing new skills, fetching extensions, and adapting its behaviour as it plays.

## Concept

Most Minecraft AI bots ship as monolithic projects: hard-coded actions, fixed prompts, a single LLM provider. This repo flips that around.

```
┌───────────────────────────────────────────────┐
│  Pi (terminal agent, model-agnostic)          │
│  ├── AGENTS.md   ← initial mandate            │
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
│  pepa Minecraft server                        │
│  Paper 26.1.2 · cracked · AuthMe · BlueMap    │
└───────────────────────────────────────────────┘
```

The Pi agent is the brain. Mineflayer is the body. The bridge between them — the skills, the prompt templates, the supervision loop — is meant to be written **by the agent itself**, starting from a minimal scaffold in this repo.

## Prerequisites

| Tool | Why | How to get it |
|---|---|---|
| **Pi** ≥ `0.75` | The agent runtime. Reads `AGENTS.md`, loads skills, calls the LLM. | `curl -fsSL https://pi.dev/install.sh \| sh` |
| **Node.js** ≥ `20` | Required by Pi and by Mineflayer. | `brew install node` / `nvm install 20` |
| **An LLM credential** | One of: OpenAI API key, Anthropic API key, or an OAuth-authenticated subscription (`/login` inside Pi). ChatGPT Pro / Claude Max work via OAuth on supported providers. | See [Authentication](#authentication) |
| **A Minecraft account or cracked nick** | The bot joins as a real player. The pepa server runs in cracked mode, so any nickname works. | — |
| **Network access to the MC server** | Direct TCP to `host:25565`. | — |

> The bot does **not** need its own Minecraft client install, server access, RCON, or any special server-side plugin. It joins as a vanilla player over the standard protocol.

## Quickstart

```bash
# 1. Clone
git clone git@github.com:xmatic-squad/pepa-pi-bot.git
cd pepa-pi-bot

# 2. Configure credentials
cp .env.example .env
$EDITOR .env          # fill in MC_HOST, MC_USERNAME, AuthMe password, LLM provider, etc.

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

On first launch Pi loads `AGENTS.md` from the project root. That file is the seed prompt — it tells the agent who it is, what server it should join, and that it is expected to extend itself.

Sessions persist by default. Use `pi -c` to resume the last conversation.

## Authentication

Pi supports **15+ LLM providers** and two credential modes:

1. **OAuth subscription login** — `pi` then `/login` inside the TUI. Suitable for ChatGPT Plus/Pro, Claude Max, and other subscriptions that ship an OAuth flow. No metered API billing.
2. **API key environment variables** — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc. Metered, but no UI.

You can mix providers via `--provider openai --model gpt-5` at launch. Cheaper models for idle ticks, smarter ones for hard decisions.

## How the agent extends itself

Pi has first-class support for three growth surfaces:

- **`skills/`** — Markdown-defined capabilities Pi can invoke. The agent can `Write` new ones at runtime when it discovers a missing capability.
- **`extensions/`** — TypeScript modules registering new tools, commands, or UI tweaks. Installed via `pi install npm:<pkg>` / `pi install git:<url>` or written in-tree.
- **`prompts/`** — Reusable prompt templates. Useful for cron-driven tick prompts ("what should I do next minute?").

The opening `AGENTS.md` instructs the agent to start by writing a `mineflayer-bridge` extension that can:
- connect to the configured MC server
- register with AuthMe
- emit world events back into the agent loop
- expose `chat / move / dig / place / equip / attack` as Pi tools

Everything beyond that — farming, exploration, base-building, player interaction — should emerge from the agent itself.

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

The pepa server is a shared survival world. The agent **must not**:
- be given OP rights on the server
- destroy player-built structures without explicit human request
- spam chat
- exfiltrate the AuthMe password or any other secret into chat / world / web

These rules are mirrored in `AGENTS.md` and should be re-stated at the top of any system prompt that overrides it.

## Status

🌱 **Seedling.** The repo currently ships only the scaffold and the initial mandate. The first real milestone is: agent connects, registers via AuthMe, sends `hello` in chat, writes its first skill (`logout-on-shutdown`). Everything past that emerges from interaction.

## License

[MIT](./LICENSE) © [xmatic-squad](https://github.com/xmatic-squad)
