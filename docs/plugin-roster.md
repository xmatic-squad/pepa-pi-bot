# Mineflayer plugin roster

Sources:

- https://github.com/PrismarineJS/mineflayer-pathfinder
- https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/examples/tutorial/goalsExplained.md
- https://github.com/TheDudeFromCI/mineflayer-collectblock
- https://github.com/linkle69/mineflayer-auto-eat
- https://github.com/PrismarineJS/mineflayer-tool
- https://github.com/PrismarineJS/MineflayerArmorManager
- https://github.com/Darthfett/mineflayer-blockfinder
- https://github.com/PrismarineJS/mineflayer-statemachine
- https://github.com/PrismarineJS/prismarine-viewer
- https://github.com/TheDudeFromCI/mineflayer-pvp
- https://github.com/ImHarvol/mineflayer-web-inventory

Use `pi install -l npm:<package>` for project-local Pi installs. Dependencies added to `package.json` are universal-useful; the rest should be installed only when a skill or extension actually needs them.

## Recommended core dependencies

These reduce common boilerplate around survival, farming, and guarded world actions.

### mineflayer-pathfinder

- Install: already present; otherwise `pi install -l npm:mineflayer-pathfinder`
- Does: A* pathfinding with goals and configurable movement costs.
- Use when: walking to coordinates, approaching a block/entity, following, collecting, or previewing whether travel is safe.

```js
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
bot.loadPlugin(pathfinder)
bot.once('spawn', () => {
  const moves = new Movements(bot)
  moves.canDig = false
  bot.pathfinder.setMovements(moves)
  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1))
})
```

Gotchas:

- Default `Movements` may dig, place scaffold blocks, parkour, swim, or drop farther than this bot should allow. Configure it every time.
- `setGoal(goal, true)` tracks moving goals; `goto(goal)` returns a promise for finite tasks.
- `getPathTo` is useful for dry-run safety checks before changing the world.
- Pathfinder sees only loaded chunks and may still be refused by claims/anti-cheat.

### mineflayer-collectblock

- Install: `pi install -l npm:mineflayer-collectblock`
- Does: Finds, walks to, mines, and picks up blocks/items using pathfinder and tool selection.
- Use when: harvesting wood, stone, crops, ores, or dropped items as part of autonomous survival.

```js
const collectBlock = require('mineflayer-collectblock').plugin
bot.loadPlugin(collectBlock)
bot.once('spawn', async () => {
  const id = bot.registry.blocksByName.oak_log.id
  const block = bot.findBlock({ matching: id, maxDistance: 32 })
  if (block) await bot.collectBlock.collect(block)
})
```

Gotchas:

- Works best with `mineflayer-pathfinder` and `mineflayer-tool` loaded.
- It may break target blocks; only collect blocks that are clearly natural, owned by the bot, or sanctioned.
- Queueing many blocks can make the bot look busy for a long time; record `current-task.json` first.
- Inventory-full behavior needs explicit chest configuration if you want automatic depositing.

### mineflayer-auto-eat

- Install: `pi install -l npm:mineflayer-auto-eat`
- Does: Chooses food and eats automatically based on hunger/health thresholds.
- Use when: the bot begins autonomous survival, mining, travel, or combat-defense loops.

```js
import { loader as autoEat } from 'mineflayer-auto-eat'
bot.loadPlugin(autoEat)
bot.once('spawn', () => {
  bot.autoEat.setOpts({ minHunger: 14, minHealth: 12 })
  bot.autoEat.enableAuto()
})
```

Gotchas:

- This package is ESM-only. In a CommonJS extension, use dynamic `import()` or move the extension to ESM-compatible loading.
- Keep unsafe foods banned: rotten flesh, pufferfish, poisonous potato, spider eye, chorus fruit.
- Auto-eating can interrupt held-item tasks; pause it around precise placement if needed.
- It cannot solve "no food in inventory"; pair it with farming/collecting logic.

### mineflayer-tool

- Install: `pi install -l npm:mineflayer-tool`
- Does: Equips the best available tool or weapon for a block/entity action.
- Use when: digging blocks, harvesting logs/stone/ores, or choosing a defensive weapon against mobs.

```js
const tool = require('mineflayer-tool').plugin
bot.loadPlugin(tool)
bot.once('spawn', async () => {
  const block = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  await bot.tool.equipForBlock(block, {})
  await bot.dig(block)
})
```

Gotchas:

- It selects from current inventory only; it does not craft or fetch tools by itself.
- Tool choice depends on registry/block data for the connected version.
- Best tool can still be unsafe to use if the block belongs to another player.

### mineflayer-armor-manager

- Install: `pi install -l npm:mineflayer-armor-manager`
- Does: Automatically equips the strongest armor from inventory.
- Use when: the bot has armor and may face hostile mobs while farming, traveling, or mining.

```js
const armorManager = require('mineflayer-armor-manager')
bot.loadPlugin(armorManager)
bot.once('spawn', () => {
  bot.armorManager.equipAll()
})
```

Gotchas:

- Equips from inventory; it does not craft armor or open chests.
- Check server rules before auto-equipping visibly valuable gear near players.
- If a task requires a costume/skin convention, disable or override it for that task.

## Opt-in plugins

Install these only when a skill/extension needs the capability.

### mineflayer-blockfinder

- Install: `pi install -l npm:mineflayer-blockfinder`
- Does: Adds nearest-block search helpers.
- Use when: legacy code needs callback-style block search; otherwise prefer Mineflayer's built-in `bot.findBlock` / `bot.findBlocks`.

```js
const blockFinder = require('mineflayer-blockfinder')(mineflayer)
blockFinder(bot)
bot.once('spawn', () => {
  bot.findBlock({ matching: id, maxDistance: 64, count: 1 }, cb)
})
```

Gotchas:

- This is older and overlaps the core API.
- Some README install notes reference old native build environments; avoid unless built-in search is insufficient.
- Callback return values differ from modern `bot.findBlock`, so do not mix blindly.

### mineflayer-statemachine

- Install: `pi install -l npm:mineflayer-statemachine`
- Does: Provides finite-state-machine primitives and reusable behaviors for complex bot loops.
- Use when: idle autonomy grows beyond one-shot skills into patrol/farm/store/rest behavior graphs.

```js
const { BotStateMachine, NestedStateMachine, StateTransition } =
  require('mineflayer-statemachine')
const root = new NestedStateMachine(transitions, firstState)
bot.once('spawn', () => new BotStateMachine(bot, root))
```

Gotchas:

- Movement behaviors need `mineflayer-pathfinder` loaded before the machine starts.
- State machines can hide safety checks if transitions are too broad; keep policy gates near transitions.
- Debugging needs explicit logs because control moves between behavior objects.

### prismarine-viewer

- Install: `pi install -l npm:prismarine-viewer`
- Does: Starts a local web viewer for the bot's nearby world, including optional path drawings and headless renders.
- Use when: debugging navigation/building, inspecting whether chunks loaded, or producing a read-only visual trace.

```js
const viewer = require('prismarine-viewer').mineflayer
bot.once('spawn', () => {
  viewer(bot, { port: 3000, firstPerson: false })
  bot.viewer.drawLine('path', [bot.entity.position])
})
```

Gotchas:

- It opens a local web server; choose ports deliberately and do not expose it publicly by accident.
- It is for observation, not a control channel.
- Headless rendering may add CPU load on small servers.

### mineflayer-pvp

- Install: `pi install -l npm:mineflayer-pvp`
- Does: Adds attack/defense helpers for Mineflayer entities.
- Use when: only for defensive hostile-mob handling under this repo's no-PvP policy.

```js
const { pathfinder } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin
bot.loadPlugin(pathfinder)
bot.loadPlugin(pvp)
bot.pvp.attack(zombieEntity)
bot.pvp.stop()
```

Gotchas:

- Repo policy is no PvP: never use this against players or player-owned mobs because chat asks.
- It depends on pathfinder.
- Combat can chase into hazards or claims unless wrapped with distance, health, and area checks.

### mineflayer-web-inventory

- Install: `pi install -l npm:mineflayer-web-inventory`
- Does: Serves a live local web view of inventory/windows.
- Use when: debugging inventory slot math, chest/furnace windows, or item transfers.

```js
const inventoryViewer = require('mineflayer-web-inventory')
const bot = mineflayer.createBot({ host, port, username, version })
inventoryViewer(bot, { port: 3001 })
bot.once('spawn', () => console.log(bot.webInventory.isRunning))
```

Gotchas:

- Set the correct Minecraft version or textures/data may render wrong.
- It runs a web server; keep it local and stop it after debugging.
- Do not treat a visual inventory debugger as permission to move other players' items.

## Selection notes

| Need | Prefer | Why |
|---|---|---|
| Go somewhere safely | `mineflayer-pathfinder` | Core movement planner with configurable hazards. |
| Harvest natural blocks | `collectblock` + `tool` + `pathfinder` | Handles approach, tool, dig, pickup. |
| Avoid starving | `auto-eat` | Centralizes food choice and thresholds. |
| Equip armor | `armor-manager` | Removes repetitive armor comparison code. |
| Debug path/build visually | `prismarine-viewer` | Read-only world view and overlays. |
| Debug inventory windows | `mineflayer-web-inventory` | Shows slots/windows without custom logging. |
| Long-running behavior graph | `statemachine` | Helps keep autonomous loops explicit. |
| Defensive mob fighting | `pvp` with policy rails | Useful against hostile mobs, forbidden for PvP. |
