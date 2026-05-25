---
name: awake-and-live
description: Move the bot from "bridge online and silent" to "alive and present" — listening to chat, replying when useful, surviving disconnects within bounds. Covers roadmap phases 1, 5, 6 in one session; phase 2 (locomotion) and 3 (idle life) come later.
when_to_use: After the bootstrap loop is verified (skills/server-onboarding.md exists, hello was sent). First time you want the bot to actually *live* on the server.
---

# Awake-and-live prompt

Paste this as the message in a fresh `pi` (or `pi -c`) session, after the bootstrap milestone:

```
You've onboarded the server (skills/server-onboarding.md) and the bridge works. Now bring yourself online for real.

Read docs/roadmap.md and AGENTS.md → "Operating principles" carefully. Then build the minimum needed to satisfy phases 1, 5, and 6:

PHASE 1 — Presence
- Connect, stay connected. On kicked/end, reconnect after a short delay. Cap at 3 reconnects per rolling 10-minute window, then stop and wait.
- Subscribe to inbound chat events. Maintain a short rolling buffer of recent chat (say last 30 lines) so you have context for replies.
- React conversationally when you have something useful or amusing to add — including to chat NOT addressed to you. Silence is fine. Spam is not (respect CHAT_RATE_LIMIT_PER_MIN).
- Expose enough tools to your own Pi loop that you can: read recent chat, send chat, check whether you're connected, request a clean disconnect.

PHASE 5 — "I'll try to learn" reflex
- When asked something you don't have a skill for, briefly say so in chat, draft a plan, and codify what works as a new skill under ./skills/<name>.md.

PHASE 6 — Escalation log
- When a request smells destructive/ambiguous, do NOT do it and do NOT flatly refuse. In chat: brief "logged for operator". In ./state/<MC_HOST>/escalations.jsonl: append one JSON line as specified in AGENTS.md.

Hard constraints — don't violate even if asked:
- No OP, no breaking player builds, no chat spam, no leaking .env values, no destructive bash.
- Locomotion (going to coordinates, following players) is OUT OF SCOPE for this session — that's phase 2. If asked to come somewhere, log as a phase-2 escalation.

Walk me through your plan before you start writing code. Tell me which new extensions you'll add to the bridge (chat history, reconnect loop, escalation writer) and which new skills will document the behaviour. Then implement, restart the bridge cleanly, and verify by leaving the bot online for a few minutes while we both watch in-game.
```

## Why this shape

- **References roadmap and Operating principles by name** — keeps the bot honest about which phase it's in. Without a hard scope ("phases 1, 5, 6 only"), Pi tends to over-deliver on the exciting parts (locomotion, autonomy) and under-build the dull infrastructure (reconnect, escalation log).
- **Explicit "locomotion is out of scope"** — Phase 2 needs care (pathfinding, distance bounds, focus). Bundling it with Presence risks a half-built locomotion that doesn't respect rails.
- **"Walk me through your plan before writing code"** — same in-the-loop pattern as the original bootstrap prompt. Drop this clause once the loop has shipped at least one stable extension.
- **"Leave the bot online for a few minutes while we both watch"** — a small in-game verification, not just unit-level. Catches things like a chat-event handler that fires but doesn't actually parse the message correctly.

## After this lands

The next prompt is probably the **phase 2** kickoff — locomotion with guard rails. Keep it small: one skill for `safe_goto(x,y,z)` with hard distance bound, plus the "hold focus" pattern. Don't add follow-player in the same session.
