# Mineflayer cheatsheet

Sources:

- https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md
- https://github.com/PrismarineJS/mineflayer/blob/master/index.d.ts
- https://github.com/PrismarineJS/mineflayer/tree/master/examples
- https://github.com/PrismarineJS/prismarine-block
- https://github.com/PrismarineJS/prismarine-item
- https://github.com/PrismarineJS/prismarine-windows
- https://github.com/PrismarineJS/prismarine-world
- https://github.com/PrismarineJS/node-minecraft-data

Target: Mineflayer 4.37.x. Treat this as a map of the API surface, not as a skill. Write skills after trying a task in the live world.

Most coordinates are `Vec3` (`vec3` package): `x` south, `y` up, `z` west. Most async methods return promises that reject when the server refuses the action, the target is gone/unloaded, the bot is not spawned, inventory is missing, or arguments are invalid.

## Bot lifecycle

| API | Params | Return / throws | Example |
|---|---|---|---|
| `mineflayer.createBot(options)` | `host`, `port`, `username`, `auth`, `version`, plus `minecraft-protocol` client options. | `Bot`. Throws synchronously for bad options; emits `error` for connection failures. | `const bot = mineflayer.createBot(opts)` |
| `bot.loadPlugin(plugin)` | Plugin function `(bot, options) => void`. | `void`. Throws if plugin code throws. | `bot.loadPlugin(pathfinder)` |
| `bot.loadPlugins(plugins)` | Array of plugin functions. | `void`. Same as `loadPlugin`. | `bot.loadPlugins([a, b])` |
| `bot.hasPlugin(plugin)` | Plugin function. | `boolean`. No network action. | `if (!bot.hasPlugin(p)) bot.loadPlugin(p)` |
| `bot.end(reason?)` | Optional disconnect reason. | `void`; closes client, then `end`. | `bot.end('manual stop')` |
| `bot.quit(reason?)` | Optional reason. | `void`; sends quit if available. | `bot.quit()` |
| `bot.respawn()` | None. | `void`; only useful after death or when auto-respawn is off. | `bot.once('death', () => bot.respawn())` |
| `bot.waitForTicks(ticks)` | Integer ticks. | `Promise<void>`; rejects if bot ends before wait completes. | `await bot.waitForTicks(20)` |
| `bot.supportFeature(name)` | Feature key from `minecraft-data`. | `boolean`. | `bot.supportFeature('theFlattening')` |

Lifecycle events:

| Event | Args | Use |
|---|---|---|
| `login` | none | Protocol login succeeded; `bot.entity` may still be missing. |
| `spawn` | none | World entity exists; safe point to read position, load movements, inspect nearby blocks. |
| `respawn` | none | Dimension/death respawn occurred; refresh nearby world assumptions. |
| `kicked` | `(reason, loggedIn)` | Server refused/removed the bot; log reason and honor reconnect caps. |
| `end` | `(reason)` | Socket/client ended; schedule bounded reconnect only if policy allows. |
| `error` | `(err)` | Network/protocol/plugin failure; do not assume bot is usable. |
| `death` | none | Bot died; inventory/location may have changed. |
| `spawnReset` | none | Spawn point changed. |

Gotcha: `bot.entity` is commonly undefined before `spawn`. Guard all world, inventory, and movement actions behind `bot.once('spawn', ...)` or a runtime status check.

## Core state

| API | Meaning | Return / throws | Example |
|---|---|---|---|
| `bot.entity` | The bot's own entity: `position`, `velocity`, `yaw`, `pitch`, `onGround`, effects, equipment. | `Entity`; unavailable before spawn. | `bot.entity.position.clone()` |
| `bot.health` | Health points, max normally 20. | `number`; updated by `health`. | `if (bot.health <= 6) retreat()` |
| `bot.food` | Hunger points, max normally 20. | `number`; updated by `health`. | `if (bot.food < 14) eatSoon()` |
| `bot.foodSaturation` | Saturation buffer. | `number`. | `bot.foodSaturation` |
| `bot.oxygenLevel` | Breath/air. | `number`; updated by `breath`. | `if (bot.oxygenLevel < 5) surface()` |
| `bot.game.gameMode` | `survival`, `creative`, `adventure`, `spectator`. | `string`; updated by `game`. | `bot.game.gameMode === 'survival'` |
| `bot.game.dimension` | `overworld`, `the_nether`, `the_end` depending on version data. | `string`. | `if (bot.game.dimension !== 'overworld') stop()` |
| `bot.game.minY`, `bot.game.height` | World vertical bounds when exposed by server data. | `number`. | `const min = bot.game.minY` |
| `bot.physics` | Client physics constants such as speed, gravity, jump speed. | Object; local simulation config. | `bot.physics.gravity` |
| `bot.physicsEnabled` | Whether Mineflayer physics simulation runs. | `boolean`; can be toggled. | `bot.physicsEnabled = false` |

## Players and entities

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.players` | Read-only directory keyed by username. | `{ [username]: Player }`; player may lack `entity` when out of view. | `bot.players[name]?.entity` |
| `bot.player` | The bot's own player record. | `Player`. | `bot.player.uuid` |
| `bot.entities` | Read-only directory keyed by entity id. | `{ [id]: Entity }`. | `Object.values(bot.entities)` |
| `bot.nearestEntity(match?)` | Predicate `(entity) => boolean`; default accepts all. | `Entity | null`. | `bot.nearestEntity(e => e.name === 'zombie')` |
| `bot.entityAtCursor(maxDistance?)` | Max reach, default about 3.5. | `Entity | null`. | `bot.entityAtCursor(4)` |

Player/entity events:

`playerJoined`, `playerUpdated`, `playerLeft`, `entitySpawn`, `entityGone`, `entityMoved`, `entityUpdate`, `entityAttributes`, `entityEffect`, `entityEffectEnd`, `entitySwingArm`, `entityHurt`, `entityDead`, `entityTaming`, `entityTamed`, `entityShakingOffWater`, `entityEatingGrass`, `entityHandSwap`, `entityWake`, `entityEat`, `entityCriticalEffect`, `entityMagicCriticalEffect`, `entityCrouch`, `entityUncrouch`, `entityEquip`, `entitySleep`, `entityElytraFlew`, `itemDrop`, `playerCollect`, `entityAttach`, `entityDetach`.

Gotcha: `bot.players[name]` can exist while `bot.players[name].entity` is null because tab-list presence is wider than render distance.

## Inventory

Inventory is a `prismarine-windows` `Window`. Common fields: `slots`, `inventoryStart`, `inventoryEnd`, `hotbarStart`, `craftingResultSlot`. Common methods: `items()`, `emptySlotCount()`, `firstEmptyInventorySlot()`, `findInventoryItem(type, metadata?, notFull?)`.

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.inventory.items()` | None. | `Item[]`; empty if no loaded inventory. | `bot.inventory.items().map(i => i.name)` |
| `bot.heldItem` | Current main-hand item. | `Item | null`. | `bot.heldItem?.name` |
| `bot.quickBarSlot` | Hotbar index `0..8`. | `number`. | `bot.quickBarSlot = 0` |
| `bot.setQuickBarSlot(slot)` | Hotbar index `0..8`. | `void`; throws on invalid slot. | `bot.setQuickBarSlot(2)` |
| `bot.equip(item, destination)` | `Item | itemType`; destination `hand`, `off-hand`, `head`, `torso`, `legs`, `feet`. | `Promise<void>`; rejects if item missing or slot invalid. | `await bot.equip(item, 'hand')` |
| `bot.unequip(destination)` | Equipment destination. | `Promise<void>`; rejects if move fails. | `await bot.unequip('head')` |
| `bot.tossStack(item)` | `Item` stack from inventory. | `Promise<void>`; rejects if item cannot be dropped. | `await bot.tossStack(item)` |
| `bot.toss(itemType, metadata, count)` | Numeric item id, metadata or null, count or null. | `Promise<void>`; rejects if not enough items. | `await bot.toss(id, null, 1)` |
| `bot.clickWindow(slot, mouseButton, mode)` | Protocol slot, button, click mode. | `Promise<void>`; low-level, easy to misuse. | `await bot.clickWindow(10, 0, 0)` |
| `bot.simpleClick.leftMouse(slot)` | Slot id. | `Promise<void>`. | `await bot.simpleClick.leftMouse(10)` |
| `bot.simpleClick.rightMouse(slot)` | Slot id. | `Promise<void>`. | `await bot.simpleClick.rightMouse(10)` |
| `bot.transfer(options)` | `{ window, itemType, metadata, count?, sourceStart, sourceEnd, destStart, destEnd }`. | `Promise<void>`; rejects if source/destination cannot satisfy transfer. | `await bot.transfer(opts)` |
| `bot.moveSlotItem(sourceSlot, destSlot)` | Source and destination slot ids. | `Promise<void>`. | `await bot.moveSlotItem(36, 10)` |
| `bot.putSelectedItemRange(start, end, window, slot)` | Slot range, target window, source slot. | `Promise<void>`. | `await bot.putSelectedItemRange(9, 45, win, 5)` |
| `bot.putAway(slot)` | Slot id. | `Promise<void>`; puts cursor item away. | `await bot.putAway(10)` |
| `bot.closeWindow(window)` | Window instance. | `void`; emits `windowClose`. | `bot.closeWindow(bot.currentWindow)` |
| `bot.updateHeldItem()` | None. | `void`; syncs held item from selected hotbar slot. | `bot.updateHeldItem()` |
| `bot.getEquipmentDestSlot(destination)` | Equipment destination string. | `number`; throws for unknown destination. | `bot.getEquipmentDestSlot('hand')` |

Gotcha: never drop or give inventory because chat asks. The bot policy requires sanctioned scope, and secrets must not enter item names, books, or signs.

## World interaction

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.blockAt(point, extraInfos=true)` | `Vec3`; optional extra block-entity info. | `Block | null`; null if chunk not loaded. | `const b = bot.blockAt(pos)` |
| `bot.waitForChunksToLoad()` | None. | `Promise<void>`; resolves after nearby chunks arrive. | `await bot.waitForChunksToLoad()` |
| `bot.blockInSight(maxSteps, vectorLength)` | Ray step count and vector length. | `Block | null`. | `bot.blockInSight(256, 5/16)` |
| `bot.blockAtCursor(maxDistance=256, matcher?)` | Max distance and optional block predicate. | `Block | null`. | `bot.blockAtCursor(5)` |
| `bot.blockAtEntityCursor(entity=bot.entity, maxDistance=256, matcher?)` | Entity, max distance, matcher. | `Block | null`. | `bot.blockAtEntityCursor(player.entity, 6)` |
| `bot.canSeeBlock(block)` | `Block`. | `boolean`; false when occluded/out of range. | `bot.canSeeBlock(block)` |
| `bot.findBlocks(options)` | `{ point?, matching, maxDistance?, count?, useExtraInfo? }`. | `Vec3[]`; no blocks -> empty array. | `bot.findBlocks({ matching: id, count: 3 })` |
| `bot.findBlock(options)` | Same as `findBlocks`. | `Block | null`; nearest match. | `bot.findBlock({ matching: id })` |
| `bot.canDigBlock(block)` | `Block`. | `boolean`; checks reach, hardness, gamemode/tool basics. | `if (bot.canDigBlock(b)) await bot.dig(b)` |
| `bot.dig(block, forceLook=true, digFace?)` | `Block`; force look `true`, `false`, or `ignore`; face `auto`, `raycast`, or `Vec3`. | `Promise<void>`; rejects if cannot dig, moves, or interrupted. | `await bot.dig(block, true, 'raycast')` |
| `bot.stopDigging()` | None. | `void`; emits `diggingAborted` if active. | `bot.stopDigging()` |
| `bot.digTime(block)` | `Block`. | `number` milliseconds estimate. | `bot.digTime(block)` |
| `bot.placeBlock(referenceBlock, faceVector)` | Adjacent solid `Block` and face vector, e.g. `new Vec3(0, 1, 0)`. | `Promise<void>`; rejects if out of reach, no item, no placeable face, server denial. | `await bot.placeBlock(ref, new Vec3(0, 1, 0))` |
| `bot.placeEntity(referenceBlock, faceVector)` | Reference block and face vector. | `Promise<Entity>`; for placeable entities. | `await bot.placeEntity(ref, face)` |
| `bot.activateBlock(block, direction?, cursorPos?)` | Block plus optional face/cursor. | `Promise<void>`; opens/uses block. | `await bot.activateBlock(chestBlock)` |
| `bot.activateEntity(entity)` | Entity. | `Promise<void>`. | `await bot.activateEntity(cow)` |
| `bot.activateEntityAt(entity, position)` | Entity and hit position. | `Promise<void>`. | `await bot.activateEntityAt(villager, pos)` |
| `bot.updateSign(block, text, back=false)` | Sign block, text, side flag. | `void`; can expose text publicly, so never include secrets. | `bot.updateSign(sign, 'Farm')` |
| `bot.consume()` | Uses held edible/drinkable item. | `Promise<void>`; rejects if not consumable or interrupted. | `await bot.consume()` |
| `bot.fish()` | Needs rod equipped and water target. | `Promise<void>`; rejects if no catch/invalid setup. | `await bot.fish()` |
| `bot.activateItem(offHand=false)` | Optional offhand flag. | `void`; starts using held item. | `bot.activateItem()` |
| `bot.deactivateItem()` | None. | `void`; stops using held item. | `bot.deactivateItem()` |
| `bot.useOn(targetEntity)` | Entity. | `void`; right-clicks entity with held item. | `bot.useOn(cow)` |
| `bot.attack(entity, swing=true)` | Entity; optional swing. | `void`; policy forbids PvP and player-directed harm. | `bot.attack(zombie)` |
| `bot.swingArm(hand?, showHand?)` | `left` or `right`; optional packet display. | `void`. | `bot.swingArm('right')` |
| `bot.mount(entity)` | Rideable entity. | `void`. | `bot.mount(boat)` |
| `bot.dismount()` | None. | `void`. | `bot.dismount()` |
| `bot.moveVehicle(left, forward)` | Steering values. | `void`; only while mounted. | `bot.moveVehicle(0, 1)` |
| `bot.getExplosionDamages(entity, position, radius, rawDamages?)` | Entity, explosion center, radius, raw flag. | `number | null`; estimate only. | `bot.getExplosionDamages(bot.entity, p, 4)` |

World/block events:

`blockUpdate`, `blockUpdate:(x, y, z)`, `blockPlaced`, `chunkColumnLoad`, `chunkColumnUnload`, `soundEffectHeard`, `hardcodedSoundEffectHeard`, `noteHeard`, `pistonMove`, `chestLidMove`, `blockBreakProgressObserved`, `blockBreakProgressEnd`, `diggingCompleted`, `diggingAborted`, `usedFirework`, `particle`.

Gotchas:

- `placeBlock` does not take the target air position. It needs the neighbor block to click and a face vector pointing into the target air cell.
- `findBlock` scans loaded chunks only. `maxDistance` beyond render distance does not load the world.
- `dig` and `placeBlock` are physical actions. Look direction, reach, selected item, gamemode, claims plugins, anti-cheat, and nearby hazards all matter.

## Movement without pathfinder

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.setControlState(control, state)` | Control: `forward`, `back`, `left`, `right`, `jump`, `sprint`, `sneak`; boolean state. | `void`; local controls persist until changed. | `bot.setControlState('forward', true)` |
| `bot.getControlState(control)` | Control name. | `boolean`. | `bot.getControlState('jump')` |
| `bot.clearControlStates()` | None. | `void`; releases all controls. | `bot.clearControlStates()` |
| `bot.lookAt(point, force?)` | `Vec3`; `force` skips smooth movement. | `Promise<void>`; rejects if bot is gone. | `await bot.lookAt(block.position.offset(.5,.5,.5))` |
| `bot.look(yaw, pitch, force?)` | Radians; optional force. | `Promise<void>`. | `await bot.look(Math.PI, 0, true)` |
| `bot.controlState` | Current control booleans. | Object. | `bot.controlState.forward` |
| `move` event | `(position)` in types; docs list no args. | Fires on movement. | `bot.on('move', savePos)` |
| `physicsTick` event | None. | Fires each physics tick. | `bot.on('physicsTick', tick)` |
| `forcedMove` event | None. | Server corrected position. | `bot.on('forcedMove', replan)` |

Gotcha: raw controls are not pathfinding. Always clear controls after a timed move or failed task, and do not use raw walking for long/unsafe travel.

## Chat

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.chat(message)` | Public chat or slash command string. | `void`; may be server-rate-limited/kicked. | `bot.chat('hello')` |
| `bot.whisper(username, message)` | Target username, message. | `void`; server may not support command. | `bot.whisper(name, 'ok')` |
| `bot.tabComplete(str, assumeCommand?, sendBlockInSight?, timeout?)` | Input string, flags, timeout. | `Promise<string[]>`. | `await bot.tabComplete('/he')` |
| `bot.chatAddPattern(pattern, chatType, description?)` | RegExp, type, optional description. | Pattern id `number`. Legacy helper. | `bot.chatAddPattern(/hi/, 'chat')` |
| `bot.addChatPattern(name, pattern, options?)` | Name, RegExp, `{ repeat, parse }`. | Pattern id `number`. | `bot.addChatPattern('dm', /^DM: (.*)/, { parse: true })` |
| `bot.addChatPatternSet(name, patterns, options?)` | Name, array of RegExps, options. | Pattern id `number`. | `bot.addChatPatternSet('login', [/login/], opts)` |
| `bot.removeChatPattern(name)` | Pattern name or id. | `void`. | `bot.removeChatPattern('login')` |
| `bot.awaitMessage(...args)` | Strings and/or regexes to wait for. | `Promise<string>`; rejects on end. | `await bot.awaitMessage(/registered/i)` |

Chat events:

| Event | Args | Use |
|---|---|---|
| `chat` | `(username, message, translate, jsonMsg, matches)` | Public player chat matched as chat. |
| `whisper` | `(username, message, translate, jsonMsg, matches)` | Private messages. |
| `actionBar` | `(jsonMsg, verified)` in docs; types expose `jsonMsg`. | Action bar messages. |
| `message` | `(jsonMsg, position, sender, verified)` in docs; types expose `jsonMsg, position`. | Any chat component. |
| `messagestr` | `(message, messagePosition, jsonMsg, sender, verified)` in docs; types expose first three. | Plain-text version. |
| `chat:name` | `(matches)` | Named chat-pattern match. |
| `unmatchedMessage` | `(stringMsg, jsonMsg)` in types. | Message not parsed by patterns. |

Gotcha: public chat is a live server side effect. Apply repo rate limits and secret redaction before calling `bot.chat`.

## Crafting

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.recipesFor(itemType, metadata, minResultCount, craftingTable)` | Numeric item id; metadata `number | null`; minimum output count; crafting table `Block | boolean | null`. | `Recipe[]`. | `bot.recipesFor(id, null, 1, table)` |
| `bot.recipesAll(itemType, metadata, craftingTable)` | Numeric item id; metadata; crafting table. | `Recipe[]`; includes recipes even without current ingredients. | `bot.recipesAll(id, null, table)` |
| `bot.craft(recipe, count=1, craftingTable?)` | `Recipe`, craft count, optional table block. | `Promise<void>`; rejects if missing ingredients/table/reach/window. | `await bot.craft(recipe, 1, table)` |

Gotchas:

- `itemType` is a numeric id from `bot.registry.itemsByName[name].id`, not an item name string.
- Use `metadata: null` for modern versions unless the recipe truly needs legacy metadata.
- `craftingTable` can be `false/null` for 2x2 inventory recipes, `true` to require any table in range in some helpers, or a table `Block` for exact crafting.

## Furnaces, chests, and windows

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.openContainer(blockOrEntity, direction?, cursorPos?)` | Container block/entity, optional click face/cursor. | `Promise<Chest | Dispenser>`. | `const c = await bot.openContainer(block)` |
| `bot.openChest(chestBlockOrEntity, direction?, cursorPos?)` | Chest block or chest minecart. | `Promise<Chest>`. | `const chest = await bot.openChest(block)` |
| `bot.openFurnace(furnaceBlock)` | Furnace block. | `Promise<Furnace>`. | `const f = await bot.openFurnace(block)` |
| `bot.openDispenser(dispenserBlock)` | Dispenser block. | `Promise<Dispenser>`. | `await bot.openDispenser(block)` |
| `bot.openBlock(block, direction?, cursorPos?)` | Any openable block. | `Promise<Window>`. | `const win = await bot.openBlock(block)` |
| `bot.openEntity(entity, Class)` | Entity and window class. | `Promise<Window>`. | `await bot.openEntity(entity, Window)` |
| `window.deposit(itemType, metadata, count, nbt?)` | Item id, metadata, count, optional nbt. | `Promise<void>`; rejects if missing items/no slots. | `await chest.deposit(id, null, 16)` |
| `window.withdraw(itemType, metadata, count, nbt?)` | Item id, metadata, count, optional nbt. | `Promise<void>`; rejects if unavailable. | `await chest.withdraw(id, null, 1)` |
| `window.close()` | None. | `void`; emits close. | `chest.close()` |
| `furnace.putInput(itemType, metadata, count)` | Smeltable item id, metadata, count. | `Promise<void>`. | `await f.putInput(rawIron, null, 3)` |
| `furnace.putFuel(itemType, metadata, count)` | Fuel item id, metadata, count. | `Promise<void>`. | `await f.putFuel(coal, null, 1)` |
| `furnace.takeInput()` | None. | `Promise<Item>`. | `await f.takeInput()` |
| `furnace.takeFuel()` | None. | `Promise<Item>`. | `await f.takeFuel()` |
| `furnace.takeOutput()` | None. | `Promise<Item>`. | `await f.takeOutput()` |
| `furnace.inputItem()` | None. | `Item | null` in practice. | `f.inputItem()?.name` |
| `furnace.fuelItem()` | None. | `Item | null` in practice. | `f.fuelItem()?.name` |
| `furnace.outputItem()` | None. | `Item | null` in practice. | `f.outputItem()?.name` |
| `furnace.fuel` | Remaining burn progress. | `number`. | `f.fuel` |
| `furnace.progress` | Current smelt progress. | `number`. | `f.progress` |

Window events: `windowOpen(window)`, `windowClose(window)`, plus per-window `open`, `close`, `updateSlot`. Furnace also emits `update`.

Gotcha: chest/furnace coordinates can identify another player's property. The bot should only open containers it owns or that a repo-approved skill says are in scope.

## Sleep, wake, time, and weather

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.sleep(bedBlock)` | Bed `Block`. | `Promise<void>`; rejects if too far, obstructed, not night/thunder, hostile nearby, occupied, or server denies. | `await bot.sleep(bed)` |
| `bot.isABed(bedBlock)` | Candidate block. | `boolean`. | `bot.isABed(block)` |
| `bot.wake()` | None. | `Promise<void>`; rejects if not sleeping/server denies. | `await bot.wake()` |
| `bot.isSleeping` | Current sleep state. | `boolean`. | `if (bot.isSleeping) await bot.wake()` |
| `bot.time.timeOfDay` | Day time `0..23999`. | `number`; updated by `time`. | `bot.time.timeOfDay > 13000` |
| `bot.time.day` | Day count. | `number`. | `bot.time.day` |
| `bot.time.isDay` | Daylight flag. | `boolean`. | `if (!bot.time.isDay) lightBase()` |
| `bot.time.moonPhase` | `0..7`. | `number`. | `bot.time.moonPhase` |
| `bot.isRaining` | Whether rain is active. | `boolean`. | `if (bot.isRaining) seekRoof()` |
| `bot.rainState`, `bot.thunderState` | Weather intensity values. | `number`. | `bot.thunderState > 0` |

Events: `sleep`, `wake`, `time`, `rain`, `weatherUpdate`.

Gotcha: sleeping is server policy sensitive. Multiplayer servers may require a percentage of players sleeping or may disable sleep.

## Other core methods

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.setSettings(options)` | Partial game settings: chat, view distance, skin parts, main hand, difficulty. | `void`; sends client settings. | `bot.setSettings({ viewDistance: 'normal' })` |
| `bot.acceptResourcePack()` | None. | `void`; accepts pending pack. | `bot.acceptResourcePack()` |
| `bot.denyResourcePack()` | None. | `void`. | `bot.denyResourcePack()` |
| `bot.elytraFly()` | None. | `Promise<void>`; rejects if no elytra/rocket/valid state. | `await bot.elytraFly()` |
| `bot.writeBook(slot, pages)` | Inventory slot and page strings. | `Promise<void>`; never write secrets. | `await bot.writeBook(slot, ['Diary'])` |
| `bot.openEnchantmentTable(block)` | Enchanting table block. | `Promise<EnchantmentTable>`. | `const e = await bot.openEnchantmentTable(b)` |
| `bot.openAnvil(block)` | Anvil block. | `Promise<Anvil>`. | `const a = await bot.openAnvil(b)` |
| `bot.openVillager(entity)` | Villager entity. | `Promise<Villager>`. | `const v = await bot.openVillager(e)` |
| `bot.trade(villager, tradeIndex, times?)` | Villager window, trade index, optional count. | `Promise<void>`. | `await bot.trade(v, 0, 1)` |
| `bot.setCommandBlock(pos, command, options)` | Position, command, command-block options. | `void`; requires server permissions. | `bot.setCommandBlock(pos, cmd, opts)` |

Policy gotcha: `setCommandBlock` requires permissions the bot must not request or assume. Treat OP/admin-dependent methods as out of scope unless the repo mandate changes.

## Creative API

Only relevant in creative mode or with server permissions.

| API | Params | Return / throws | Example |
|---|---|---|---|
| `bot.creative.setInventorySlot(slot, item)` | Slot id and `Item | null`. | `Promise<void>`. | `await bot.creative.setInventorySlot(36, item)` |
| `bot.creative.clearSlot(slot)` | Slot id. | `Promise<void>`. | `await bot.creative.clearSlot(36)` |
| `bot.creative.clearInventory()` | None. | `Promise<void>`. | `await bot.creative.clearInventory()` |
| `bot.creative.flyTo(destination)` | `Vec3`. | `Promise<void>`. | `await bot.creative.flyTo(pos)` |
| `bot.creative.startFlying()` | None. | `void`. | `bot.creative.startFlying()` |
| `bot.creative.stopFlying()` | None. | `void`. | `bot.creative.stopFlying()` |

## Full event list

| Group | Events |
|---|---|
| Chat/messages | `chat`, `whisper`, `actionBar`, `message`, `messagestr`, `unmatchedMessage`, `chat:name` |
| Lifecycle/session | `inject_allowed`, `login`, `spawn`, `respawn`, `game`, `resourcePack`, `kicked`, `end`, `error`, `spawnReset`, `death` |
| Titles/weather/time | `title`, `title_times`, `title_clear`, `rain`, `weatherUpdate`, `time` |
| Health/player state | `health`, `breath`, `experience`, `heldItemChanged`, `sleep`, `wake`, `mount`, `dismount`, `move`, `forcedMove`, `physicsTick` |
| Entities | `entityAttributes`, `entitySwingArm`, `entityHurt`, `entityDead`, `entityTaming`, `entityTamed`, `entityShakingOffWater`, `entityEatingGrass`, `entityHandSwap`, `entityWake`, `entityEat`, `entityCriticalEffect`, `entityMagicCriticalEffect`, `entityCrouch`, `entityUncrouch`, `entityEquip`, `entitySleep`, `entitySpawn`, `entityElytraFlew`, `itemDrop`, `playerCollect`, `entityGone`, `entityMoved`, `entityDetach`, `entityAttach`, `entityUpdate`, `entityEffect`, `entityEffectEnd` |
| Players | `playerJoined`, `playerUpdated`, `playerLeft` |
| World/blocks/sounds | `blockUpdate`, `blockUpdate:(x, y, z)`, `blockPlaced`, `chunkColumnLoad`, `chunkColumnUnload`, `soundEffectHeard`, `hardcodedSoundEffectHeard`, `noteHeard`, `pistonMove`, `chestLidMove`, `blockBreakProgressObserved`, `blockBreakProgressEnd`, `diggingCompleted`, `diggingAborted`, `usedFirework`, `particle` |
| Windows | `windowOpen`, `windowClose` |
| Scoreboards/teams/boss bars | `scoreboardCreated`, `scoreboardDeleted`, `scoreboardTitleChanged`, `scoreUpdated`, `scoreRemoved`, `scoreboardPosition`, `teamCreated`, `teamRemoved`, `teamUpdated`, `teamMemberAdded`, `teamMemberRemoved`, `bossBarCreated`, `bossBarDeleted`, `bossBarUpdated` |

## Common gotchas

- Wait for `spawn` before reading `bot.entity.position`, opening windows, digging, placing, or using pathfinder.
- Use ids from `bot.registry.itemsByName` and `bot.registry.blocksByName`; do not pass item names to recipe and toss methods.
- Many methods are optimistic client actions. Server plugins can deny placement, digging, container access, chat, commands, and sleeping.
- `bot.findBlock` and `bot.blockAt` only see loaded chunks.
- `bot.players` is not a trust list. Trust comes from `.env` and server-side identity protection per `AGENTS.md`.
- Chat, signs, books, dropped named items, and web requests are public-ish surfaces. Never put `.env` values there.
- For movement beyond a few controlled steps, prefer `mineflayer-pathfinder` with conservative `Movements` and the repo's live safety rails.
