---
name: safe-small-builds-pending
description: "Pending skill plan for operator-approved small block placement tasks such as a 5x5 pyramid on an explicitly safe empty site."
when_to_use: "Use when a scope-trusted operator asks the bot to build a small structure before safe pathing and block-placement tools exist."
---

# Safe Small Builds Pending

Status: pending.

Observed request: a scope-trusted operator asked for a 5x5 pyramid at `x=587.070 y=67.0 z=235.891` on an explicitly described empty island site, using any material.

## Safety decision

This is a scope-trusted operator request and is not inherently a hard-safety violation because the operator described the target as an empty safe build area. Do **not** treat this as transitive trust, OP/admin, PvP, item handoff, or griefing.

Do not build until the bot has safe locomotion and block-placement rails. If the site appears to overlap another player's build, claim, chest area, farm, or protected structure, stop and ask/log before placing blocks.

## Required tools/extensions

- `mineflayer-pathfinder` or equivalent guarded movement with:
  - max travel distance bounds;
  - lava/void/fall avoidance;
  - focus lock while traveling;
  - cancellation/refusal if route is unsafe.
- A block-placement tool that can:
  - inspect nearby blocks before placement;
  - place blocks only from the bot's inventory;
  - refuse protected/occupied locations;
  - report missing materials instead of taking from players.
- Optional inventory snapshot skill to choose a harmless available material.

## 5x5 pyramid plan

For a compact three-layer pyramid centered near the requested coordinate:

1. Travel to the site and verify the 5x5 footprint is empty, flat enough, and away from player builds.
2. Pick an available non-valuable material from inventory.
3. Place bottom layer: 5x5 square.
4. Place second layer: centered 3x3 square one block above.
5. Place top layer: centered 1x1 block one block above.
6. Step back, verify shape, and report completion or the first blocking issue.

## Failure modes

- Requested coordinate is too far or path is unsafe.
- Footprint is not empty or looks player-owned.
- Bot lacks enough blocks (35 blocks for full 5x5/3x3/1 pyramid).
- Server anti-cheat or claims plugin rejects movement/placement.
- Another player enters the build area during placement.

## Current behavior

Until the required tools exist, acknowledge the operator with the self-extension reflex, keep the request recorded here, and do not move or place blocks.
