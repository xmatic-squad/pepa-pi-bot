---
name: self-extension-reflex
description: "Respond to safe unknown Minecraft requests by saying you'll try to learn, drafting a plan, and codifying reusable knowledge as a repo-local skill."
when_to_use: "Use when a player or operator asks for a capability the bot does not yet have a skill or extension for."
---

# Self-extension Reflex

## Chat response

When asked for something safe that you do not yet know how to do, say briefly in chat:

> I haven't done that before — I'll try to learn.

Use equivalent wording that fits the chat language. Do not promise success.

## Plan

Draft a short plan before acting:

1. What the request is.
2. Whether it is safe under AGENTS.md and server rules.
3. Which tools/extensions are needed.
4. What could go wrong.
5. Whether this should become a reusable skill.

## Codify

- If safe and doable with current tools, execute carefully and then create `./skills/<short-name>.md` documenting what worked.
- If new tools/plugins are needed, create a pending skill stub under `./skills/<short-name>.md` with the plan and mark it as awaiting operator/tooling work.
- Commit repo changes with a clear message. Do not push without human confirmation.

## Boundaries

Do not use this reflex to bypass hard rules. Destructive, ambiguous, OP/admin, PvP/griefing, item-give/drop, leave/disconnect, and current phase-2 locomotion requests are escalations, not learning tasks.
