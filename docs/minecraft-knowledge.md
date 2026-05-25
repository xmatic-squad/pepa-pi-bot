# Minecraft knowledge for a farmer bot

Target: Minecraft Java 1.21.x. The observed server path uses a 1.21.5 client through ViaBackwards/Paper compatibility, so prefer 1.21-compatible recipes and mechanics. This is reference material; use it to shorten research before drafting skills.

See also: [`minecraft-recipes.json`](./minecraft-recipes.json) for machine-readable recipe shapes.

## World rules

Sources:

- https://minecraft.wiki/w/Daylight_cycle
- https://minecraft.wiki/w/Sleeping
- https://minecraft.wiki/w/Weather
- https://minecraft.wiki/w/Light
- https://minecraft.wiki/w/Mob_spawning
- https://minecraft.wiki/w/Spawn

| Topic | Practical rule |
|---|---|
| Time | One full day is 24000 game ticks = 20 real minutes at 20 TPS. Day starts at 0, noon 6000, sunset around 12000, midnight 18000. |
| Night risk | Hostiles become the main surface risk after sunset and during thunderstorms. Plan roof/light before long idle work. |
| Sleep | A bed can be entered at night or during thunderstorms if the bot is close enough, the bed is usable, and hostile mobs are not too near. Multiplayer servers may require only some players to sleep, all players to sleep, or may disable sleeping. |
| Weather | Rain darkens the sky, hydrates farmland, extinguishes exposed fire, and lets some daylight-burning mobs survive longer. Thunderstorms darken enough for hostile spawning behavior and lightning hazards. Savannas/deserts do not receive ordinary rain. |
| Light values | Light is 0-15. Block light falls by 1 per block of taxicab distance from the source. Sky light exposed to open sky is 15 and spreads, but internal sky light changes with time/weather. |
| Hostile spawning | In modern Java, most common hostile overworld mobs require block light 0 plus normal spawn space/surface rules. Sky light/internal sky light can still matter outside caves. |
| Passive spawning | Many farm animals need grass blocks, air space, and a higher light level; they are unreliable in dark pens. |
| Spawn surfaces | Most mobs need a solid top surface and enough empty collision space. Buttons, slabs, carpets, water, leaves, fences, and transparent/non-full blocks can change spawnability. |
| Player distance | Natural hostile spawning generally happens away from players, not right on top of them. Do not assume a lit base is safe if dark caves nearby remain loaded. |

Bot heuristics:

- Before night: get under a roof or place light sources around the work area.
- For conservative mob-proofing, keep walkable surfaces at block light 8 or above. For 1.21 most common hostile mobs only need block light 0, but 8+ is an easy safety margin and works across older assumptions.
- Do not build farms where the bot must jump on farmland; jumping can trample it.

## Mobs

Sources:

- https://minecraft.wiki/w/Zombie
- https://minecraft.wiki/w/Skeleton
- https://minecraft.wiki/w/Creeper
- https://minecraft.wiki/w/Spider
- https://minecraft.wiki/w/Enderman
- https://minecraft.wiki/w/Slime
- https://minecraft.wiki/w/Witch
- https://minecraft.wiki/w/Drowned
- https://minecraft.wiki/w/Husk
- https://minecraft.wiki/w/Phantom
- https://minecraft.wiki/w/Cow
- https://minecraft.wiki/w/Sheep
- https://minecraft.wiki/w/Pig
- https://minecraft.wiki/w/Chicken
- https://minecraft.wiki/w/Bee
- https://minecraft.wiki/w/Wolf

| Mob | Type | Spawn / trigger | Threat | Drops / value | Defeat or avoid |
|---|---|---|---|---|---|
| Zombie | Hostile | Overworld dark areas, commonly block light 0; variants by biome. | Medium melee; babies are high threat. | Rotten flesh; rare iron, carrot, potato. | Kite backward, use sword/axe, avoid groups, let sun burn if safe. |
| Skeleton | Hostile | Dark overworld areas; bows. | High early threat because ranged knockback. | Bones, arrows, rare bow. | Use shield/cover, close distance in zigzags, avoid open fields at night. |
| Creeper | Hostile | Dark overworld areas; silent approach. | Very high. Explosion damages bot and builds. | Gunpowder; music disc if killed by skeleton. | Keep distance, knock back, break line of sight, never fight near base/chests. |
| Spider | Neutral/hostile | Dark spaces needing wider 3x1x3 room. Hostile in low light, neutral in bright light unless hit. | Medium; climbs walls. | String, spider eye. | Fight in open, keep roof lips/fences, do not rely on low walls. |
| Enderman | Neutral | Solid surface with 3-block headroom; rare overworld. | High if provoked; teleports. | Ender pearl, held block. | Do not stare at face, avoid hitting, use water/low roof if forced. |
| Slime | Hostile | Swamps Y 51-69 in low light and slime chunks below Y 40. | Low to medium; splits. | Slimeballs. | Kill large forms carefully, fence off swamp work at night. |
| Witch | Hostile | Dark areas, huts, raids/trials; uses potions. | High sustain threat. | Potion ingredients: redstone, glowstone, gunpowder, bottles, sticks, sugar, spider eyes. | Avoid early; burst down with bow/axe, keep distance from poison. |
| Drowned | Hostile | Rivers/oceans and drowned zombies. | Medium; trident drowned are high. | Rotten flesh, copper, rare trident/nautilus shell. | Avoid underwater fights; use shore/blocks; watch river bases at night. |
| Husk | Hostile | Desert at night/storms, block light 0; does not burn in sun. | Medium; inflicts hunger. | Zombie-like drops. | Avoid desert bases early; fight like zombie but do not count on daylight. |
| Phantom | Hostile | Night/thunder if player has not slept or died for 3+ in-game days and sky is exposed. | Medium/high dive attacker. | Phantom membrane. | Sleep periodically, roof work areas, keep cats later. |
| Cow | Passive | Grass blocks in many biomes, lit, 2-block space. | None. | Beef, leather, milk with bucket. | Fence and breed with wheat. |
| Sheep | Passive | Grass blocks, light; many biomes. | None. | Wool, mutton; shears preserve sheep. | Breed with wheat; shear instead of kill when wool needed. |
| Pig | Passive | Grass blocks in many biomes. | None. | Porkchop. | Breed with carrot, potato, or beetroot. |
| Chicken | Passive | Grass blocks; also eggs. | None. | Chicken, feathers, eggs. | Breed with seeds; collect eggs for passive expansion. |
| Bee | Neutral | Bee nests near flowers/trees. | Low until angered; swarm can hurt. | Honey/honeycomb if managed. | Do not break nests; use campfire under hive before harvesting. |
| Wolf | Neutral/tamable | Forest/taiga style biomes. | Low unless attacked; useful when tamed. | None worth farming. | Do not hit; tame later with bones if useful. |

## Biomes for early bases

Sources:

- https://minecraft.wiki/w/Plains
- https://minecraft.wiki/w/Forest
- https://minecraft.wiki/w/River
- https://minecraft.wiki/w/Savanna
- https://minecraft.wiki/w/Biome

| Biome | Base value | Offers | Watch-outs |
|---|---|---|---|
| Plains | Best all-round starter. | Open sightlines, villages/outposts possible, flowers, grass seeds, animals, occasional oak. | Few trees; easy for skeletons/creepers to see the bot at night. |
| Forest | Best wood supply. | Oak/birch, wolves, bees, flowers, shade. | Dense leaves hide mobs and make pathing harder; fire risk. |
| River edge | Good utility strip near another biome. | Water, clay/sand/gravel patches, sugar cane nearby, fish/squid/salmon, easy farm irrigation. | Drowned, steep banks, bot can get stuck/swim slowly. |
| Savanna | Strong warm starter. | Acacia/oak, villages, horses/donkeys, warm animal variants, no normal rain. | Dry storms can still allow mobs; acacia terrain/plateaus can complicate pathing. |

Early base heuristic: choose plains or savanna near a forest edge and water. Keep at least 16-24 blocks away from existing player builds unless the operator explicitly scopes the area.

## Food

Sources:

- https://minecraft.wiki/w/Food
- https://minecraft.wiki/w/Hunger
- https://minecraft.wiki/w/Bread
- https://minecraft.wiki/w/Baked_Potato
- https://minecraft.wiki/w/Cooked_Beef
- https://minecraft.wiki/w/Cooked_Chicken
- https://minecraft.wiki/w/Carrot
- https://minecraft.wiki/w/Potato

Mechanics:

- Hunger max is 20. Natural regeneration normally needs hunger 18+ or remaining saturation.
- Saturation is spent before hunger. High-saturation food keeps the bot productive longer.
- Sprinting stops at low hunger; starvation starts at 0.
- Avoid foods with bad effects unless explicitly planned: rotten flesh, pufferfish, poisonous potato, spider eye, raw chicken.

| Food | Hunger | Saturation | Source | Bot note |
|---|---:|---:|---|---|
| Steak / cooked porkchop | 8 | 12.8 | Cook cow/pig drops. | Best common meat. |
| Cooked chicken / cooked mutton | 6 | 7.2 / 9.6 | Cook chicken/sheep drops. | Good farm food. |
| Bread | 5 | 6.0 | 3 wheat. | Reliable early crop food. |
| Baked potato | 5 | 6.0 | Cook potatoes. | Strong once potato farm exists. |
| Carrot | 3 | 3.6 | Zombies, villages, crop farm. | No cooking; also pig/rabbit breeding. |
| Potato | 1 | 0.6 | Zombies, villages, crop farm. | Cook before eating. |
| Apple | 4 | 2.4 | Oak/dark oak leaves, loot. | Backup, not a farm plan. |
| Cake | 14 total | 2.8 total | Wheat, sugar, egg, milk. | Stationary food; awkward for bot travel. |

Sustainable order: wheat -> bread; chickens from seeds/eggs -> cooked chicken; potatoes -> baked potatoes; cows -> steak plus leather.

## Farming

Sources:

- https://minecraft.wiki/w/Tutorial:Crop_farming
- https://minecraft.wiki/w/Farmland
- https://minecraft.wiki/w/Bone_Meal
- https://minecraft.wiki/w/Breeding
- https://minecraft.wiki/w/Wheat
- https://minecraft.wiki/w/Carrot
- https://minecraft.wiki/w/Potato
- https://minecraft.wiki/w/Beetroot

Crop rules:

| Crop | Seed/input | Growth | Harvest | Bot note |
|---|---|---|---|---|
| Wheat | Wheat seeds from grass. | 8 stages, mature at age 7. Needs farmland and light 9+ at plant block. | Wheat + 1-4 seeds when mature. | First crop: bread and cow/sheep breeding. |
| Carrot | Carrot item planted directly. | 8 stages. Same farmland/light logic. | 1-4 carrots. | Good no-cook snack and pig food. |
| Potato | Potato item planted directly. | 8 stages. Same farmland/light logic. | 1-4 potatoes, rare poisonous potato. | Bake for real food value. |
| Beetroot | Beetroot seeds. | 4 stages. Same farmland/light logic. | Beetroot + 1-4 seeds. | Pig food/dye/soup; lower priority. |

Farmland and growth:

- Hydration comes from water up to 4 blocks horizontally, same level or 1 above. One center water block hydrates a 9x9 farmland square.
- Hydrated farmland grows crops faster than dry farmland.
- Crops need light level 9+ at the crop block. Torches let underground farms grow.
- Alternating rows of different crops or crop/empty farmland improve growth probability.
- Bone meal advances crops by random stages; it is good for emergency food or seed multiplication.
- Cover water with a slab/carpet/lily pad to stop the bot falling in and jumping out over farmland.

Animal breeding:

| Animal | Breeding item | Product | Cooldown / growth | Bot note |
|---|---|---|---|---|
| Cow | Wheat | Baby cow, XP | Parents: 5 min cooldown; baby: 20 min, wheat speeds growth. | Best long-term food/leather. |
| Sheep | Wheat | Baby sheep, XP | Same cooldown/growth; baby can also grow by eating grass. | Wool for beds plus mutton. |
| Pig | Carrot, potato, or beetroot | Baby pig, XP | Same cooldown/growth. | Good if carrots/potatoes are available. |
| Chicken | Seeds | Chick, XP; eggs every 5-10 min. | Same cooldown/growth; seeds speed chicks. | Easiest to scale from seeds/eggs. |

Pen rules:

- Fence animals before breeding; leave gates the bot can path to.
- Light pens and roofs/overhangs enough to avoid hostile mobs and lightning-sensitive villagers.
- Do not overcrowd; entity cramming can kill animals on some servers.

## Resource layers

Sources:

- https://minecraft.wiki/w/Ore
- https://minecraft.wiki/w/Ore_(feature)
- https://minecraft.wiki/w/Altitude

The 1.18+ distribution is terrain- and biome-shaped, so these are practical mining targets, not guarantees. Deepslate variants generally appear below Y=8.

| Resource | Total overworld range | Peak / most found | Required pickaxe | Notes |
|---|---:|---:|---|---|
| Coal | Y 0 to 320 | Around Y 45 | Wooden+ | Avoids air exposure in many blobs; mountains help. |
| Iron | Y -64 to 72 and high mountains | Around Y 14; high distribution in mountains | Stone+ | Early mining target; also exposed in caves/cliffs. |
| Copper | Y -16 to 112 | Around Y 43 | Stone+ | Larger blobs in dripstone caves. |
| Gold | Y -64 to 32 | Around Y -18 | Iron+ | Much more common in badlands up to high Y. |
| Redstone | Y -64 to 16 | Around Y -59 | Iron+ | Deep mining; needs iron pickaxe. |
| Diamond | Y -64 to 16 | Around Y -59 | Iron+ | Best deep target; lava/cave risk is high. |
| Lapis lazuli | Y -64 to 64 | Around Y -2 | Stone+ | Useful for enchanting later. |

Bot mining heuristic: start with exposed coal/iron near surface/caves, then controlled stair mine. Do not deep-mine autonomously without a return plan, torches, food, and a current-task checkpoint.

## Tools and weapons

Sources:

- https://minecraft.wiki/w/Tools
- https://minecraft.wiki/w/Pickaxe
- https://minecraft.wiki/w/Axe
- https://minecraft.wiki/w/Shovel
- https://minecraft.wiki/w/Hoe
- https://minecraft.wiki/w/Sword
- https://minecraft.wiki/w/Durability
- https://minecraft.wiki/w/Breaking

Progression:

| Tier | Durability rough order | Mining level | Use |
|---|---:|---|---|
| Wood | Very low | Stone/coal only basics. | Emergency first tool; replace quickly. |
| Stone | Low | Iron, copper, lapis, coal. | Main day-1 tool tier. |
| Iron | Medium | Gold, redstone, diamond. | First serious mining/base tier. |
| Diamond | High | Obsidian and all normal ores. | Durable late survival. |
| Netherite | Highest | Diamond-level plus lava/fire item resistance. | Requires smithing, not early-game. |
| Gold | Very low | Limited mining despite speed. | Usually not worth tools except special cases. |

Tool matching:

- Pickaxe: stone/ores/deepslate.
- Axe: logs, planks, many wooden blocks; also high melee damage but slower.
- Shovel: dirt, gravel, sand, clay, snow.
- Hoe: crops, leaves, hay bales, sculk-ish blocks; also creates farmland.
- Sword: safer general mob weapon; avoid PvP per policy.

Durability notes:

- Every block break with the right tool costs durability. Wrong-tool use can be slow and still waste durability.
- Do not spend iron/diamond tools on trivial blocks if stone/wood works.
- `mineflayer-tool` can equip good tools, but safety/ownership decisions remain the bot's job.

## Crafting recipes

Sources:

- https://minecraft.wiki/w/Crafting
- https://minecraft.wiki/w/Recipe
- https://minecraft.wiki/w/Tools
- https://minecraft.wiki/w/Furnace
- https://minecraft.wiki/w/Chest
- https://minecraft.wiki/w/Bed
- https://minecraft.wiki/w/Door
- https://minecraft.wiki/w/Fence
- https://minecraft.wiki/w/Ladder
- https://minecraft.wiki/w/Torch
- https://minecraft.wiki/w/Bucket
- https://minecraft.wiki/w/Shears
- https://minecraft.wiki/w/Bow
- https://minecraft.wiki/w/Arrow
- https://minecraft.wiki/w/Bread
- https://minecraft.wiki/w/Cake
- https://minecraft.wiki/w/Sugar
- https://minecraft.wiki/w/Paper
- https://minecraft.wiki/w/Book
- https://minecraft.wiki/w/Sign

Notation: rows are top-to-bottom; `.` means empty; shapeless means ingredients can be anywhere.

| Recipe | Shape / ingredients | Yields |
|---|---|---:|
| Planks | shapeless: any log/stem | 4 |
| Sticks | `plank / plank` | 4 |
| Crafting table | `plank plank / plank plank` | 1 |
| Wooden pickaxe | `plank plank plank / . stick . / . stick .` | 1 |
| Wooden axe | `plank plank / plank stick / . stick` | 1 |
| Wooden shovel | `plank / stick / stick` | 1 |
| Wooden sword | `plank / plank / stick` | 1 |
| Wooden hoe | `plank plank / . stick / . stick` | 1 |
| Stone pickaxe | `stone stone stone / . stick . / . stick .` | 1 |
| Stone axe | `stone stone / stone stick / . stick` | 1 |
| Stone shovel | `stone / stick / stick` | 1 |
| Stone sword | `stone / stone / stick` | 1 |
| Stone hoe | `stone stone / . stick / . stick` | 1 |
| Iron pickaxe | `iron iron iron / . stick . / . stick .` | 1 |
| Iron axe | `iron iron / iron stick / . stick` | 1 |
| Iron shovel | `iron / stick / stick` | 1 |
| Iron sword | `iron / iron / stick` | 1 |
| Iron hoe | `iron iron / . stick / . stick` | 1 |
| Golden hoe | `gold gold / . stick / . stick` | 1 |
| Diamond hoe | `diamond diamond / . stick / . stick` | 1 |
| Netherite hoe | smithing: diamond hoe + netherite ingot + upgrade template | 1 |
| Furnace | `stone stone stone / stone . stone / stone stone stone` | 1 |
| Chest | `plank plank plank / plank . plank / plank plank plank` | 1 |
| Bed | `wool wool wool / plank plank plank` | 1 |
| Door | `plank plank / plank plank / plank plank` | 3 |
| Fence | `plank stick plank / plank stick plank` | 3 |
| Ladder | `stick . stick / stick stick stick / stick . stick` | 3 |
| Torch | `coal_or_charcoal / stick` | 4 |
| Bucket | `iron . iron / . iron .` | 1 |
| Shears | `. iron / iron .` | 1 |
| Bow | `. stick string / stick . string / . stick string` | 1 |
| Arrow | `flint / stick / feather` | 4 |
| Bread | `wheat wheat wheat` | 1 |
| Cake | `milk milk milk / sugar egg sugar / wheat wheat wheat` | 1 |
| Sugar | shapeless: sugar cane | 1 |
| Paper | `sugar_cane sugar_cane sugar_cane` | 3 |
| Book | shapeless: paper + paper + paper + leather | 1 |
| Sign | `plank plank plank / plank plank plank / . stick .` | 3 |

## Smelting

Sources:

- https://minecraft.wiki/w/Smelting
- https://minecraft.wiki/w/Furnace
- https://minecraft.wiki/w/Fuel
- https://minecraft.wiki/w/Charcoal
- https://minecraft.wiki/w/Raw_Iron
- https://minecraft.wiki/w/Raw_Gold
- https://minecraft.wiki/w/Raw_Copper

Furnace basics:

- A normal furnace takes 10 seconds / 200 ticks per item.
- Blast furnaces smelt ores/materials twice as fast; smokers cook food twice as fast.
- Fuel is consumed at the start of a burn. If output is blocked, fuel can still burn down.
- Chunks must stay loaded for furnace progress.

Common inputs:

| Input | Output | Bot use |
|---|---|---|
| Raw iron | Iron ingot | Tools, bucket, shears, armor. |
| Raw copper | Copper ingot | Building/lightning rod later. |
| Raw gold | Gold ingot | Powered rails, golden carrots/apples later. |
| Sand | Glass | Safe windows/greenhouse. |
| Cobblestone | Stone | Cleaner building, stonecutter recipes. |
| Log | Charcoal | Renewable torch fuel. |
| Raw beef/pork/chicken/mutton | Cooked food | Better hunger/saturation. |
| Potato | Baked potato | Good crop food. |

Common fuels:

| Fuel | Smelts approx. | Note |
|---|---:|---|
| Coal / charcoal | 8 items | Main early fuel. |
| Planks | 1.5 items | Emergency fuel; usually preserve wood. |
| Logs | 1.5 items | Better turned into charcoal when possible. |
| Sticks | 0.5 item | Tiny overflow fuel. |
| Lava bucket | 100 items | Great bulk fuel; bucket returned after use. |
| Block of coal | 80 items | Efficient for large batches. |
| Dried kelp block | 20 items | Renewable later. |

## Safe building

Sources:

- https://minecraft.wiki/w/Light
- https://minecraft.wiki/w/Torch
- https://minecraft.wiki/w/Lantern
- https://minecraft.wiki/w/Jack_o%27Lantern
- https://minecraft.wiki/w/Glowstone
- https://minecraft.wiki/w/Fence
- https://minecraft.wiki/w/Door
- https://minecraft.wiki/w/Mob_spawning

Light sources worth remembering:

| Block | Light | Use |
|---|---:|---|
| Torch | 14 | Cheapest early base/farm light. |
| Lantern | 15 | Compact, hangs/stands, costs iron nugget. |
| Jack o'lantern | 15 | Solid farm light, works under water/blocks. |
| Glowstone / sea lantern | 15 | Later decorative strong light. |
| Campfire | 15 | Light plus smoke/cooking; can burn entities. |
| Furnace while lit | 13 | Temporary light only. |

Mob-proofing:

- Conservative target: every walkable surface in and around base/farm should be light 8+.
- Modern 1.21 target for most hostile overworld mobs: avoid block light 0 on spawnable blocks.
- Slabs, carpets, buttons, glass, leaves, water, and other non-full/transparent blocks can prevent or alter spawning, but use them deliberately.
- Fence livestock pens; add gates and lights. Two-block-high walls or roof lips help against spiders.
- Roof sleeping/farm work areas so phantoms and rain cannot interrupt long idle tasks.
- Keep creeper fights away from builds. A "safe" base is not safe if a creeper is allowed to detonate near a chest wall.
