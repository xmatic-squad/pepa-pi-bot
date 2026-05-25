---
name: safe-small-builds
description: "Use guarded block-placement tools for scope-trusted small builds, especially a 5x5 pyramid on an explicitly safe empty site."
when_to_use: "Use when a scope-trusted operator asks the bot to build a small structure such as a 5x5 pyramid."
---

# Safe Small Builds

Status: implemented pending bridge reload.

Observed request: a scope-trusted operator asked for a 5x5 pyramid at `x=587.070 y=67.0 z=235.891` on an explicitly described empty island site, using any material.

The bridge now registers `mc_build_pyramid_5x5`.

## Safety decision

This is a scope-trusted operator request and is not inherently a hard-safety violation because the operator described the target as an empty safe build area. Do **not** treat this as transitive trust, OP/admin, PvP, item handoff, or griefing.

The tool still refuses to build if the inspected site appears to overlap another player's build, claim, chest area, farm, protected-looking block, hazardous block, occupied entity area, or non-air footprint.

## Tool behavior

`mc_build_pyramid_5x5({ x, y, z, material?, dry_run? })`:

1. Rounds X/Z to the intended center and floors Y as the bottom-layer Y.
2. Requires 35 safe placeable inventory blocks.
3. Uses guarded travel to approach the site.
4. Inspects the 5x5/3x3/1 footprint and nearby radius.
5. Places:
   - bottom layer: 5x5 square;
   - second layer: centered 3x3 square one block above;
   - top layer: centered 1x1 block.
6. Stops on the first blocker and reports it.

## Failure modes

- Requested coordinate is too far or path is unsafe.
- Footprint is not empty or lacks solid support.
- Nearby blocks look player-made/protected.
- Bot lacks 35 safe placeable blocks.
- Server anti-cheat or claims plugin rejects movement/placement.
- Another entity enters the build area during placement.

## Current requested build

After the bridge reloads, the queued operator request can be attempted with:

```json
{"x":587.070,"y":67.0,"z":235.891}
```
