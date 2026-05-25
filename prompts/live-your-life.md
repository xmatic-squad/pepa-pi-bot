---
name: live-your-life
description: Switch the bot from reactive (chat-driven) to autonomous, goal-driven mode. Reads state/<MC_HOST>/goal.md as the long-term ambition, decomposes into plan.md, executes, journals into diary/, can be interrupted by operator messages and resumes after.
when_to_use: After Phase 0/1/operator-trust are done AND a goal.md exists for this server AND the operator wants the bot to live independently (e.g. while away).
---

# Live-your-life prompt

Paste this in your active `pi` session (or a fresh one). The bot should be online and idle (no active task).

```
The repo and memory model just grew. Re-read in this order:
- AGENTS.md — pay attention to the new "Long-term goal and personal memory" section AND the rewritten Operating principles #4 ("bias to action") and #5 ("goal-driven autonomy with priority order").
- docs/memory-model.md — the formal shared-knowledge vs personal-memory split.
- ./state/<MC_HOST>/goal.md — your long-term ambition on this server, just seeded by the operator.

Then enter autonomous mode. Specifically:

1. Read your goal. If ./state/<MC_HOST>/plan.md does not exist, decompose the goal into a short ordered list of milestones (5-10 items, each completable in one or two play sessions). Write it as plan.md. The plan is yours — you'll rewrite it as you learn what's actually feasible.

2. Implement the memory protocol from Operating principle #5:
   - ./state/<MC_HOST>/current-task.json — write before every meaningful action; clear on completion. Read first on every session start.
   - ./state/<MC_HOST>/diary/YYYY-MM-DD.md — append one or two lines per significant action.
   - ./state/<MC_HOST>/locations.json — register named places as you build/find them.
   If the bridge extension does not yet have helpers for these, add them. Don't write a "pending" stub — install/wire, then act.

3. Implement the priority-order loop from Operating principle #5. Concretely, the bridge needs (or already has) an idle-tick mechanism: when chat has been silent for ~5-10 minutes and no operator task is active, the bridge prompts you ("what's next?") and you make one move toward the current plan milestone. If this loop doesn't exist yet, add it.

4. Implement resume-on-restart: on bridge startup, after AuthMe auth completes, before announcing yourself in chat, read current-task.json. If non-empty, log "resuming: <task>" to diary and continue from there. If empty, log "starting fresh session" and consult plan.md.

5. Start. Pick a starting milestone (probably "scout for and pick a base site near a safe area with water + trees"), write the current-task.json, and go. The operator may be afk; that's fine — work the plan. If you get stuck on something the new "bias to action" rule still can't resolve (genuine safety violation, unrecoverable failure), THEN escalate, but don't escalate on "I'm not sure if I'm allowed" — the operator already said live your life.

Hard constraints (still absolute, even in autonomy):
- All hard safety rules from AGENTS.md.
- No trespassing into existing player builds. The goal.md non-goals list is binding.
- Diary entries are concise — one or two lines per action, not paragraphs. The diary is memory, not narration.
- Don't push to git on your own from autonomous mode — commit locally if you ship a skill, the operator will review and push.

Walk me through your plan.md draft before you start executing. Once I confirm or amend it, you're free to run.
```

## Why this shape

- **Re-read three docs in order** — fresh AGENTS, the new memory-model doc, and the operator-seeded goal. Pi needs all three loaded before it can act coherently.
- **Numbered concrete asks (1-5)** — same pattern as awake-and-live. Without them, "live your life" is too open; Pi will think rather than build.
- **Explicit "don't write a pending stub, install and act"** in step 2 — this is the corrective for the over-caution we observed on the pyramid task.
- **"Push from autonomous mode = no"** — autonomy is for in-world actions, not for source-control side effects. Local commits accumulate; the operator pushes when they look at the diff.
- **Plan.md draft for review** — keeps the human in the loop for the *direction* without micromanaging the *execution*. Drop this gate after the bot ships its first milestone.

## After this lands

- The bot is now goal-driven. Chat with it goes into the operator-task priority (highest); otherwise it works the plan.
- The diary becomes the primary way to see what the bot has been doing — `cat state/<MC_HOST>/diary/$(date +%F).md` whenever you're curious.
- If you want to redirect long-term, edit `state/<MC_HOST>/goal.md`. If you want to redirect short-term, edit `plan.md` or just send a chat message.
- If you ever want to pause autonomy and go fully reactive again, in chat: `пепа, остановись, переходи в presence mode пока я не скажу обратно`. Bot honours operator scope.
- Phase 3 of the roadmap (`🌱 Best life when idle`) effectively starts the moment this prompt is accepted. Bump it to 🌿 in the README after the first plan.md is written.
