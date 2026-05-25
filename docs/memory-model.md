# Memory model

> Two kinds of memory live in this repo. They look similar from inside a `pi` session, but they have very different lifecycles, ownership, and contribution model. Mixing them up is the most common way to break either community growth or per-instance continuity.

## TL;DR

| Layer | Lives in | Pushed to git? | Owned by | Survives a re-clone? | Survives a restart? |
|---|---|---|---|---|---|
| **Shared knowledge** | `skills/`, `extensions/`, `prompts/`, `docs/`, `.pi/settings.json` | ✅ yes | the community (every clone has the same set) | ✅ yes — that's the whole point | ✅ yes |
| **Personal memory** | `state/<MC_HOST>/`, `logs/` | ❌ no, `.gitignore`d | this specific bot instance running against this specific server | ❌ no — a fresh clone is a fresh bot | ✅ yes (local disk persists) |

If you find yourself wondering "should I commit this?", the question is really: **would another clone of pepa-pi-bot pointed at a different server benefit from this file?**

- Generic capability ("how to build a 5×5 pyramid", "how to handle AuthMe re-login") → **shared knowledge** → commit.
- Specific lived experience ("on Tuesday I built the village center at 587 67 235", "my chest with iron is at 600 64 220") → **personal memory** → never commit.

## Shared knowledge — what goes in the repo

The bot extends itself by writing files. Anything that captures **reusable know-how** belongs in the repo so the next clone — or someone running the bot on a totally different server — benefits.

- **`skills/<name>.md`** — markdown-defined capabilities the bot can invoke. Cookbook entries for "how to do X". A skill should be portable to a different server with at most light edits.
- **`extensions/<name>.{ts,js}`** — TypeScript modules that register real Pi tools or hook into Mineflayer events. Code, not lore.
- **`prompts/<name>.md`** — reusable prompt templates for kickoff sessions, tick loops, etc.
- **`docs/<topic>.md`** — architecture, design decisions, the roadmap.
- **`.pi/settings.json`** — project Pi config (installed extensions, model defaults). Committing it ensures a fresh clone reproduces the same tool stack with one `npm install`.

The repo is the bot's **library**. Anyone running the bot anywhere reads from the same library.

## Personal memory — what stays local

This is the bot's **diary, ledger, and notebook**, scoped to a specific MC server. It mirrors what a real player would carry in their head (and a chest at home).

- **`state/<MC_HOST>/goal.md`** — the long-term objective on this server (e.g. "build a small village in the island plains biome and survive long-term"). Optional, seeded by the operator or written by the bot from a chat directive.
- **`state/<MC_HOST>/plan.md`** — current decomposition of the goal into milestones (e.g. "1. shelter built ✓ 2. wheat farm ✓ 3. iron tools ⬜ 4. cow pasture ⬜").
- **`state/<MC_HOST>/current-task.json`** — what the bot is doing *right now*, written before each meaningful action and cleared on completion. Critical for **resume after restart**: when Pi reloads, the bot reads this file first and either continues or asks for direction.
- **`state/<MC_HOST>/locations.json`** — named places that matter on this server: `base`, `farm`, `mine_entry`, `nearest_village`. Written as the bot discovers/builds them.
- **`state/<MC_HOST>/diary/YYYY-MM-DD.md`** — per-day journal. One or two lines per significant action ("chopped 32 oak", "killed a creeper at 590 65 232"). Lets the bot reconstruct context after a long absence and lets the operator skim the bot's week.
- **`state/<MC_HOST>/inventory-log.jsonl`** — periodic inventory snapshots for trend tracking ("am I accumulating wood faster than I burn it?").
- **`state/<MC_HOST>/escalations.jsonl`** + **`.seen`** — already present, see Operating principle #7 in AGENTS.md.

**Per-server isolation is deliberate.** If the same checkout is pointed at a different `MC_HOST`, it gets a separate `state/<MC_HOST>/` directory. The bot doesn't accidentally "remember" coordinates from a server where those coordinates mean nothing.

## What about cross-server learnings?

When the bot learns something that *would* apply to any server (a better recovery procedure, a smarter pathfinding heuristic, a clever way to handle anti-cheat plugins), it should:

1. Codify the generalised lesson into `skills/<name>.md` — **shared knowledge**.
2. Keep the server-specific specifics (the exact coords where the lesson was learned, the exact player who triggered it) in the server's `diary/` — **personal memory**.

Cross-server insight is *abstracted* before it gets into the repo. The server's diary preserves the raw experience locally; the skill preserves the abstracted lesson globally.

## What about logs?

- `logs/bridge-live.log` and `logs/bridge-live.pid` — runtime traces. Gitignored. Useful for debugging a specific incident; not part of the bot's curated memory.
- A diary entry can reference a log file or line range, but the diary entry itself is the primary memory artefact.

## Resume after restart

When the bridge restarts (Pi reload, host reboot, crash), the bot's startup sequence reads from personal memory in this order:

1. `state/<MC_HOST>/joined-before.flag` — has this nickname been registered with AuthMe?
2. `state/<MC_HOST>/current-task.json` — was I in the middle of something?
3. `state/<MC_HOST>/plan.md` — what's the current top-level milestone I'm working towards?
4. `state/<MC_HOST>/goal.md` — what's the long-term ambition?
5. `state/<MC_HOST>/diary/YYYY-MM-DD.md` — what did I do recently?

The bot should be able to resume any task interrupted mid-flight without the operator having to re-state context. If the operator wants to redirect, they can edit `current-task.json` or `plan.md` directly — those *are* the trusted control surface for in-progress work, just as `AGENTS.md` is the trusted control surface for behaviour.

## Anti-pattern: committing state

If a `state/<host>/` file ever ends up in `git status` as tracked, that's a bug:

- Other clones will inherit one bot's specific lived experience as if it were their own.
- Secrets (coordinates of hidden chests, etc.) will be public on GitHub.
- Merge conflicts on the diary every time two clones run in parallel.

The `.gitignore` rule (`state/`) prevents this. If you ever need to share a specific lived insight publicly, abstract it into a skill first.

## Anti-pattern: gitignoring shared knowledge

The opposite mistake: putting a useful skill or extension under `state/` or `logs/` and losing it on the next clone. If you find yourself writing a "draft skill" or "prototype extension" outside `skills/`/`extensions/`, ask whether it's actually a personal-memory artefact or a shared-knowledge one — and move it to the right place before the next commit.
