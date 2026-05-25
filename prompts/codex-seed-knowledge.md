---
name: codex-seed-knowledge
description: One-shot research+writing task for a Codex-class agent (or any long-context autonomous coding agent) — produce a comprehensive docs/ knowledge base so the bot doesn't have to rediscover Mineflayer and Minecraft mechanics from scratch every time it tries something new. Works on a separate branch, opens a PR, never touches main.
when_to_use: Once per significant Minecraft-version era, or whenever the bot's "I'll try to learn" loop is visibly slow due to missing reference material. Not a Pi prompt — feed to Codex Pro / Claude Sonnet long-context / similar.
---

# Seed-knowledge prompt — for Codex Pro (or equivalent autonomous coding agent)

Paste this verbatim to a long-context autonomous coding agent (Codex Pro, Claude Sonnet via API with repo access, etc.). It is NOT a Pi prompt and not for the bot itself — it's for a separate worker agent that augments the repo.

```
# Task — augment pepa-pi-bot with a comprehensive knowledge base

You are augmenting the public repository github.com/xmatic-squad/pepa-pi-bot (MIT) with a reference layer so the bot doesn't have to rediscover Mineflayer and Minecraft mechanics every time. This is a multi-hour research + writing task. Take your time, cite sources, be thorough but terse.

## Read context FIRST (no edits before this)

Clone the repo locally if you haven't: git clone git@github.com:xmatic-squad/pepa-pi-bot.git

Read in this order:
- README.md — what the project is
- AGENTS.md — the bot's mandate, especially Operating principles #4 (I'll try to learn) and #5 (goal-driven autonomy)
- docs/memory-model.md — the shared (repo) vs personal (state/) memory split
- docs/roadmap.md — phased growth plan
- extensions/mineflayer-bridge.ts — DO NOT EDIT, but read to understand the tools the bot has already exposed (mc_chat, mc_position, mc_goto, mc_build_pyramid_5x5, mc_status, mc_recent_chat, mc_log_escalation, mc_disconnect, mc_is_operator)
- skills/*.md — the skills the bot has written itself. Note their style; do not write new ones in their format. You write REFERENCE material, the bot writes its own skills.

## Philosophical guardrail — docs ≠ skills

This task is to give the bot a "library" to consult. NOT to write its skills for it.

- skills/ is the bot's notebook of *its own* procedures. Off limits.
- docs/ is the textbook. That's where you contribute.
- Emergence preservation: the bot must still draft its own skill when it tries something — your docs just shorten the trial-and-error inside that drafting.

Test of whether something is "skill" vs "doc": if it tells the bot "do X in this exact order to accomplish Y", it's a skill (don't write). If it tells the bot "here's how Mineflayer represents Y, here are the relevant methods", it's a doc (do write).

## Deliverables — each on the feat/knowledge-base branch

### 1. docs/mineflayer-cheatsheet.md

Complete API surface reference for Mineflayer (~4.37.x). Structured by namespace:

- bot lifecycle (login, spawn, kicked, end, error)
- bot.entity (position, yaw, pitch, health, food, gameMode)
- bot.players, bot.entities (read-only directories)
- bot.inventory (slots, items, equip, drop, toss)
- World interaction: bot.dig, bot.placeBlock, bot.activateBlock, bot.lookAt, bot.findBlock, bot.blockAt
- Movement (without pathfinder): bot.setControlState, bot.look, bot.physics
- Chat: bot.chat, bot.whisper, message events
- Crafting: bot.recipesFor, bot.craft, bot.recipesAll
- Furnace and chest interaction (windows API)
- Sleep, wake, time, weather
- Events (full list of events the bot can subscribe to)
- Common gotchas (bot.entity undefined before spawn; bot.recipesFor expects metadata; placeBlock needs a referenceBlock + faceVector; etc.)

For each method: signature, params, return type, throws, ≤3-line example. Don't paste the entire upstream docs — paraphrase tightly.

### 2. docs/plugin-roster.md

For each plugin: npm package name, install command (use `pi install -l npm:<pkg>` form), what it does in one sentence, when to use, ≤10-line basic usage snippet, common gotchas.

Cover at minimum:
- mineflayer-pathfinder (already installed; refresh usage with goals, movements config)
- mineflayer-collectblock
- mineflayer-auto-eat
- mineflayer-tool
- mineflayer-armor-manager
- mineflayer-blockfinder
- mineflayer-statemachine
- prismarine-viewer (read-only headless world view, may help debugging)
- mineflayer-pvp — INCLUDE with a note that the bot's policy is no-PvP, but the plugin can be used defensively against hostile mobs

Add any other actively-maintained plugins worth knowing.

### 3. docs/minecraft-knowledge.md

Practical knowledge a "farmer bot" needs. Target version: 1.21.x (the bot connects as 1.21.5 through ViaBackwards; server is Paper 26.1.2 but recipes are compatible). Split into sections:

- World rules: day/night cycle in ticks, sleeping conditions, weather effects, light propagation, mob spawning rules (light level, sky access, block type)
- Mobs: hostile/passive/neutral table. For each common mob: spawn conditions, threat level, drops, how to defeat or avoid. Focus on overworld; ignore nether/end.
- Biomes: which biomes are good for early-game base (plains, forest, river, savanna). Mention what each biome offers (trees, animals, water, hostile mobs).
- Food: hunger/saturation mechanics, what restores how much, sustainable food sources (wheat, carrots, potatoes, bread, cooked meat).
- Farming: wheat/carrot/potato/beetroot growth requirements (hydrated farmland, light, growth stages, bonemeal), animal breeding (cow/sheep/pig/chicken — food, cooldown, baby growth).
- Resource layers: Y-level distribution for coal, iron, copper, gold, redstone, diamonds, lapis (current ore distribution as of 1.18+).
- Tools & weapons: progression (wood → stone → iron → diamond), durability, mining levels.
- Crafting recipes (most important ~40): wooden planks, sticks, crafting table, all wooden tools, all stone tools, all iron tools, furnace, chest, bed, door, fence, ladder, torch, hoe (each tier), bucket, shears, bow, arrow, bread, cake, sugar, paper, book, sign. For each: ingredients in shape (3x3 grid notation) + count.
- Smelting: what goes in furnace, what fuel works, how long.
- Safe building: which blocks emit light, mob-proofing (light level ≥ 8), how to roof an area, how to fence livestock.

Be concise. Use tables where they help. Don't paste Minecraft Wiki — paraphrase. Cite the wiki URLs you drew from at the top of each section.

### 4. docs/minecraft-recipes.json (optional, helpful)

The recipes from section above in machine-readable form. Schema:
{
  "name": "wooden_pickaxe",
  "shape": [["plank","plank","plank"],[null,"stick",null],[null,"stick",null]],
  "yields": 1
}

The bot can load this and pick a recipe by name without re-reading prose. If size becomes large, split into multiple files (basic-tools.json, food.json, blocks.json).

### 5. package.json updates

Add the core recommended plugins to "dependencies":
- mineflayer-collectblock
- mineflayer-auto-eat
- mineflayer-tool
- mineflayer-armor-manager

Leave statemachine, pvp, blockfinder, viewer for the bot to opt into later via `pi install -l`. The four above are universal-useful and reduce inventory/eating boilerplate the bot would otherwise write itself.

After updating package.json, run `npm install` and commit the lockfile too.

### 6. AGENTS.md — one line added to Operating principle #4

Add a sentence like: "Before trying something new in Mineflayer or in the Minecraft world, glance at docs/mineflayer-cheatsheet.md, docs/plugin-roster.md, docs/minecraft-knowledge.md as relevant — they cover the common case; you write the skill afterward in your own style."

DO NOT make broader edits to AGENTS.md.

## Hard constraints

- Work on branch `feat/knowledge-base`. NEVER push to main. When you're done, open a PR — do not merge it; the operator (halofourteen) reviews.
- Hands off: extensions/, skills/, state/, prompts/, .env*, .pi/. Only docs/, package.json/lock, and the one AGENTS.md line are in scope.
- Cite sources at the top of every .md you create — list URLs you drew from.
- Don't copy more than ~15 consecutive words from any external source (Minecraft Wiki is CC-BY-NC-SA, Mineflayer docs are MIT — paraphrase regardless).
- The bot is connected to a LIVE Minecraft server (play.xmatic.team) and may be active during your work. Your branch work doesn't affect it. Just don't merge.
- Commit incrementally — one commit per major file, descriptive messages. Use the project's existing commit style (look at git log for examples).

## Sources to draw from

Primary:
- Mineflayer API docs: https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md
- Mineflayer wiki/examples: https://github.com/PrismarineJS/mineflayer/wiki and https://github.com/PrismarineJS/mineflayer/tree/master/examples
- prismarine-* libraries on github (prismarine-block, prismarine-item, prismarine-windows, etc.)
- Each plugin's GitHub README for install/usage
- Minecraft Wiki: https://minecraft.wiki/ (search-as-you-go for recipes, mobs, ore distribution, biomes)
- Mindcraft project for structural inspiration (NOT for copying): https://github.com/kolbytn/mindcraft — their skills.js is a good list of "what a mineflayer bot ends up needing", but write fresh content, not derivative.

## Definition of done

- Branch feat/knowledge-base pushed
- PR opened with description: which files added, total line counts, list of sources cited, ~30-second summary of what the bot can now skip rediscovering
- All four docs files exist and are internally consistent (cross-link where useful)
- npm install succeeds with the new plugins, lockfile committed
- No edits outside the allowed surface

## Estimated scope

10-30 hours of focused work. The bottleneck is research quality, not writing speed. If something is uncertain (e.g. exact ore Y-level distribution differs between 1.18 and 1.21), say so in the doc rather than guess.

Begin.
```

## Why this shape

- **PR-based, not push to main.** The live bot operates on `main`; your worker agent operates on a branch. The bot is unaffected until the operator merges.
- **docs/ only**, never `skills/` or `extensions/`. The whole point of pepa-pi-bot is that the bot writes its own procedures — pre-writing skills kills that and turns the repo into a static toolkit.
- **One-line AGENTS.md edit, not a rewrite.** The behaviour change is "consult docs/ before attempting a new task" — anything bigger should come from the operator, not a research agent.
- **Estimated scope upfront** lets the worker agent budget reasoning effort. Underspec'd "do research" tasks get either shallow-and-fast or deep-and-runaway results; "10-30 hours" calibrates.
- **Definition of done** is concrete and verifiable, not subjective.

## Review checklist after PR opens

Before merging:

- [ ] Spot-check `docs/mineflayer-cheatsheet.md` against the real Mineflayer API for one or two methods (signatures match upstream package).
- [ ] Spot-check `docs/minecraft-knowledge.md` for any factual claim that smells like a hallucination — Y-levels, recipe shapes, mob spawn conditions.
- [ ] Confirm `package.json` only added the four expected plugins, nothing else; `npm install` passes locally; lockfile updated.
- [ ] Confirm AGENTS.md edit is a single sentence inside Operating principle #4, not a broader rewrite.
- [ ] No `skills/`, no `extensions/`, no `state/` touched.
- [ ] Sources cited at the top of each new .md.

After merge → reload Pi (`Ctrl+D` then `pi` in the project dir). The bot's next session loads the new docs automatically via `.pi/settings.json`.

## When to re-run this prompt

- A major Minecraft version bump changes recipes / mob mechanics enough that `docs/minecraft-knowledge.md` is wrong.
- Mineflayer ships a major API change (4.x → 5.x).
- The community adopts a new must-have plugin not in the current roster.

Each re-run is its own branch + PR. Don't overwrite — accumulate.
