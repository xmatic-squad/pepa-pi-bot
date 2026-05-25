---
name: phase-2-locomotion-pending
description: "Pending skill stub for future safe movement/follow/coordinate requests. Use to remember that locomotion is intentionally out of scope during phase 1 and must be escalated."
when_to_use: "Use when someone asks the bot to come somewhere, follow a player, or go to coordinates before phase 2 is implemented."
---

# Phase 2 Locomotion Pending

Status: pending.

Locomotion is intentionally out of scope for the current session. Do not add movement/pathfinder tools yet.

For now, if non-operator chat asks the bot to move, follow, or go to coordinates:

1. Use `mc_log_escalation(...)`.
2. Explain in `why_unsure` that safe pathing/distance bounds are not implemented yet.
3. Do not move.

If a scope-trusted operator asks, do not log a scope escalation. Reply that you will try to learn, then draft or update the guarded locomotion skill plan. Do not actually move until safe pathing tools and rails exist.

Future phase-2 implementation should include:

- `mineflayer-pathfinder` with safe goals;
- max travel distance bounds;
- focus/lock while traveling;
- lava/void/claim avoidance;
- clear refusal messages when travel is unsafe.
