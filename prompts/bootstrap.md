---
name: bootstrap
description: First-run prompt to send to Pi after `pi /login` and `cp .env.example .env`. Kicks the agent into building its own mineflayer bridge per AGENTS.md.
when_to_use: First time launching the agent in a fresh checkout, or whenever you want to reset and re-run the bootstrap loop from scratch.
---

# Bootstrap prompt

Paste this as the very first message in a new `pi` session:

```
You're awake. Read AGENTS.md and the repo's current state, then begin executing "First objective — bootstrap your own body" from AGENTS.md. Walk me through each step before you run it the first time — I want to see which Pi tooling (extensions API, skill API, plain bash, etc.) you choose for the mineflayer bridge.
```

## Why this shape

- **"You're awake"** — soft cue that this is the beginning of a session, not a one-shot question.
- **"Read AGENTS.md and the repo's current state"** — Pi auto-loads AGENTS.md, but a second explicit read keeps the agent honest about which version it's working from. It also forces a quick scan of `package.json` / `.env.example` / existing `skills/` and `extensions/`.
- **"Begin executing First objective"** — direct hand-off to the procedural list in AGENTS.md. No need to re-state the steps here.
- **"Walk me through each step before you run it the first time"** — keeps a human in the loop for the first bootstrap. After the loop is stable you can drop this clause and let the agent run unattended.
- **"…which Pi tooling you choose"** — surfaces an architectural decision (extension vs skill vs bash) instead of letting Pi make it silently.

## After the first run

Once the bridge is working and `skills/server-onboarding.md` is written, the next session prompt can be much shorter, e.g.:

```
Resume. Check the server's online, log in if needed, and report status.
```

Or schedule a tick prompt (see `prompts/tick.md` once that exists).
