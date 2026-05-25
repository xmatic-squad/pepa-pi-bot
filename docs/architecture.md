# Architecture

> Longer-form design notes. The agent is encouraged to edit this file as the system evolves.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Operator                                                   │
│  (timmy / halofourteen — in-game chat, repo edits, .env)    │
└─────┬────────────────────────────────────────────┬──────────┘
      │                                            │
      │ chat / edit AGENTS.md                       │ optional: Telegram (future)
      ▼                                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Pi runtime                                                 │
│  - loads AGENTS.md, skills/, extensions/, prompts/          │
│  - runs an interactive or scheduled session                 │
│  - delegates tool calls to extensions                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  mineflayer-bridge (extension, written by the agent)        │
│  - holds a single bot client                                │
│  - exposes mc_chat / mc_position / mc_dig / ... as tools    │
│  - pushes world events into the agent loop                  │
└────────────────────┬────────────────────────────────────────┘
                     │ TCP 25565
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  pepa Paper server                                          │
│  - AuthMe gates login                                       │
│  - BlueMap renders the world                                │
│  - host: play.xmatic.team                                   │
└─────────────────────────────────────────────────────────────┘
```

## Why Pi as the runtime

- **Model-agnostic.** Same project can swap OpenAI ↔ Anthropic ↔ Gemini per session without code changes.
- **Self-extending.** Pi has first-class skills/extensions APIs — the agent can write its own tools at runtime.
- **OAuth subscription support.** A ChatGPT Pro or Claude Max subscription removes per-token billing for development.
- **Local-first.** No required cloud service. Everything lives in this repo and `~/.pi/`.

## Why Mineflayer as the body

- **Version coverage.** Supports MC 1.8 → 1.21.x with auto-detect; the pepa server (Paper 26.1.2) sits inside that range.
- **High-level API.** No need to hand-roll the Minecraft protocol. Movement, pathfinding (via `mineflayer-pathfinder`), inventory, and chat are first-class.
- **Cracked-friendly.** `auth: 'offline'` works against AuthMe-gated servers without a Microsoft account.

## What's intentionally absent (for now)

- **MCP server.** A separate MCP server could expose the same tools to Claude Desktop or other clients. Out of scope until there's a concrete need for a second consumer.
- **Telegram bridge.** Two-way ops chat over Telegram is a planned future skill. The `.env.example` reserves the env vars but the wiring is not built.
- **Long-term memory.** The agent will rely on Pi sessions + this repo for now. If/when context-window growth becomes painful, a vector store will be added as a skill.
- **Sandboxing.** The agent currently has full shell access in the repo dir. We rely on the safety rules in `AGENTS.md` plus the safety boundary that the bot has no OP rights server-side.

## Deployment

Local dev for now. Once the seed loop is stable, the same repo will be deployed as a `compose` service on the pepa VPS itself (8 GB RAM is enough to run the MC server + a Pi process + Mineflayer). No code changes expected — everything is read from `.env`.

## Open questions

- Does Pi's OAuth flow currently support ChatGPT Pro? Codex CLI does, but it's not documented for Pi. **Action**: try `pi /login` and observe.
- How are extensions loaded long-term — `pi install -e ./extensions/mineflayer-bridge.ts`, or via `--extension` flag, or by adding to settings? **Action**: read pi.dev/docs/latest's Extensions section before writing the bridge.
- What's the right tick cadence? 60s is a guess. Probably needs to be event-driven (react to chat/world events) rather than purely cron.
