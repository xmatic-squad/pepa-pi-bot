---
name: phase-2-locomotion
description: "Use guarded Mineflayer pathfinder movement for trusted/sanctioned coordinate requests, with distance, focus, and hazard rails."
when_to_use: "Use when a scope-trusted operator or repo-sanctioned skill asks the bot to come somewhere, follow a safe coordinate instruction, or go to coordinates."
---

# Phase 2 Locomotion

Status: implemented pending bridge reload.

The bridge now registers `mc_goto` using `mineflayer-pathfinder`.

## Rails

- Refuses targets farther than `MAX_TRAVEL_BLOCKS` from current position (default `500`).
- Keeps one active world-task lock; do not context-switch while walking/building.
- Uses safe movements:
  - no digging;
  - no scaffold placement;
  - no 1x1 towers;
  - no parkour;
  - max drop-down of 2;
  - avoids water/lava/fire/magma/cactus/campfire/berry/powder-snow/cobweb hazards.
- Refuses if health or food is critically low.
- Supports `dry_run` for path preview.

## Use

For a scope-trusted operator request such as `go to 100 64 -200`:

1. Confirm it is not a hard-safety issue.
2. Check no active world task is running (`mc_status`).
3. Call `mc_goto({ x, y, z, range })`.
4. If it fails, report the blocker in chat instead of forcing movement.

For non-operator requests, chat remains dialog-only unless a repo skill explicitly sanctions movement.

## Not implemented yet

- Dynamic following of a moving player.
- Claim-plugin awareness beyond refusing protected-looking build sites in small-build tools.
