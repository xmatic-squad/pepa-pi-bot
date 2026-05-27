// Seed the knowledge DB with starter content shipped in the repo.
// Idempotent: only inserts rows that aren't already present (UPSERT
// keyed by `name`).
//
// Sources:
//   docs/minecraft-recipes.json — recipes table
//   inline MOB_INTEL / BLOCK_INTEL / STARTER_LESSONS arrays — bootstrap
//     knowledge so the bot has something to consult before any wiki/
//     post-mortem run has populated the DB.
//
// Call seed() once after ensureStore(). Cheap (single transaction,
// ~50 rows). No network. No Pi.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isAvailable, getStore } from "./store.js";
import { info, warn } from "../log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECIPES_JSON = resolve(HERE, "..", "..", "docs", "minecraft-recipes.json");

// Compact intel for the most common hostiles + a few passives.
// `verdict_no_weapon`: what the bot should do when caught without a sword.
// `verdict_with_sword`: what to do with at least a wooden sword.
// Sources: docs/minecraft-knowledge.md (already synthesised from wiki).
const MOB_INTEL = [
	{ name: "zombie",   hostility: "hostile",  threat_level: 2, approach_range: 16, burns_in_sun: 1, ranged: 0,
		weakness: "sunlight", drops: ["rotten_flesh","iron_ingot","carrot","potato"],
		verdict_no_weapon: "flee", verdict_with_sword: "kite",
		notes: "Babies move fast — flee on sight even with a sword if your hp<14." },
	{ name: "husk",     hostility: "hostile",  threat_level: 3, approach_range: 16, burns_in_sun: 0, ranged: 0,
		weakness: "water", drops: ["rotten_flesh"],
		verdict_no_weapon: "shelter", verdict_with_sword: "kite",
		notes: "Desert zombie variant; doesn't burn in daylight; inflicts hunger." },
	{ name: "skeleton", hostility: "hostile",  threat_level: 3, approach_range: 16, burns_in_sun: 1, ranged: 1,
		weakness: "melee_in_cover", drops: ["bone","arrow","bow"],
		verdict_no_weapon: "shelter", verdict_with_sword: "kite",
		notes: "Ranged — never approach in open. Close distance only if you have a shield or terrain cover." },
	{ name: "creeper",  hostility: "hostile",  threat_level: 5, approach_range: 16, burns_in_sun: 0, ranged: 0,
		weakness: "knockback", drops: ["gunpowder"],
		verdict_no_weapon: "flee", verdict_with_sword: "kite",
		notes: "Silent, explodes within 3 blocks. Keep > 5 blocks distance ALWAYS. Never fight near base." },
	{ name: "spider",   hostility: "neutral",  threat_level: 2, approach_range: 16, burns_in_sun: 0, ranged: 0,
		weakness: "high_ground", drops: ["string","spider_eye"],
		verdict_no_weapon: "pillar", verdict_with_sword: "attack",
		notes: "Climbs walls. Pillar up 2 blocks for safety. Daytime spider is neutral unless hit." },
	{ name: "enderman", hostility: "neutral",  threat_level: 4, approach_range: 64, burns_in_sun: 0, ranged: 0,
		weakness: "water", drops: ["ender_pearl"],
		verdict_no_weapon: "avoid", verdict_with_sword: "avoid",
		notes: "Don't look at the head. Hostile only if provoked. Teleports — fights are unpredictable." },
	{ name: "drowned",  hostility: "hostile",  threat_level: 3, approach_range: 16, burns_in_sun: 0, ranged: 1,
		weakness: "above_water", drops: ["rotten_flesh","copper_ingot","trident","nautilus_shell"],
		verdict_no_weapon: "flee", verdict_with_sword: "kite",
		notes: "Trident variants ranged & deadly. Don't fight in water." },
	{ name: "witch",    hostility: "hostile",  threat_level: 4, approach_range: 16, burns_in_sun: 0, ranged: 1,
		weakness: "burst_damage", drops: ["redstone","glowstone_dust","gunpowder","sugar","stick","glass_bottle","spider_eye"],
		verdict_no_weapon: "flee", verdict_with_sword: "avoid",
		notes: "Throws poison/weakness potions. Avoid until iron sword + apples." },
	{ name: "slime",    hostility: "hostile",  threat_level: 1, approach_range: 16, burns_in_sun: 0, ranged: 0,
		weakness: "split_into_smaller", drops: ["slime_ball"],
		verdict_no_weapon: "pillar", verdict_with_sword: "attack",
		notes: "Splits when killed. Common in swamp at night." },
	{ name: "phantom",  hostility: "hostile",  threat_level: 3, approach_range: 64, burns_in_sun: 1, ranged: 0,
		weakness: "burns_in_sun", drops: ["phantom_membrane"],
		verdict_no_weapon: "shelter", verdict_with_sword: "kite",
		notes: "Triggered by not sleeping 3+ days. Sleep when possible." },
	{ name: "cow",     hostility: "passive",  threat_level: 1, drops: ["beef","leather"], verdict_no_weapon: "attack", verdict_with_sword: "attack", notes: "Hit until dead for food/leather. Breed with wheat." },
	{ name: "sheep",   hostility: "passive",  threat_level: 1, drops: ["wool","mutton"], verdict_no_weapon: "attack", verdict_with_sword: "attack", notes: "Shear for wool (sheep lives) or kill for mutton+wool. Breed with wheat." },
	{ name: "chicken", hostility: "passive",  threat_level: 1, drops: ["chicken","feather","egg"], verdict_no_weapon: "attack", verdict_with_sword: "attack", notes: "Lays eggs every 5-10 min. Breed with seeds." },
	{ name: "pig",     hostility: "passive",  threat_level: 1, drops: ["porkchop"], verdict_no_weapon: "attack", verdict_with_sword: "attack", notes: "Breed with carrot/potato/beetroot." },
	{ name: "wolf",    hostility: "neutral",  threat_level: 2, drops: [], verdict_no_weapon: "avoid", verdict_with_sword: "avoid", notes: "Don't hit. Tame with bones later." },
];

const BLOCK_INTEL = [
	{ name: "oak_log",       required_tool: "axe",            drops: ["oak_log"],       light_emit: 0,  notes: "Any axe; fists work but slow." },
	{ name: "birch_log",     required_tool: "axe",            drops: ["birch_log"],     light_emit: 0 },
	{ name: "spruce_log",    required_tool: "axe",            drops: ["spruce_log"],    light_emit: 0 },
	{ name: "dark_oak_log",  required_tool: "axe",            drops: ["dark_oak_log"],  light_emit: 0 },
	{ name: "jungle_log",    required_tool: "axe",            drops: ["jungle_log"],    light_emit: 0 },
	{ name: "acacia_log",    required_tool: "axe",            drops: ["acacia_log"],    light_emit: 0 },
	{ name: "mangrove_log",  required_tool: "axe",            drops: ["mangrove_log"],  light_emit: 0 },
	{ name: "cherry_log",    required_tool: "axe",            drops: ["cherry_log"],    light_emit: 0 },
	{ name: "stone",         required_tool: "wood_pickaxe",   drops: ["cobblestone"],   light_emit: 0,  notes: "Needs wood pickaxe minimum; otherwise drops nothing." },
	{ name: "cobblestone",   required_tool: "wood_pickaxe",   drops: ["cobblestone"],   light_emit: 0 },
	{ name: "deepslate",     required_tool: "wood_pickaxe",   drops: ["cobbled_deepslate"], light_emit: 0 },
	{ name: "coal_ore",      required_tool: "wood_pickaxe",   drops: ["coal"],          light_emit: 0 },
	{ name: "iron_ore",      required_tool: "stone_pickaxe",  drops: ["raw_iron"],      light_emit: 0,  notes: "Needs stone pickaxe; wood pickaxe drops nothing." },
	{ name: "copper_ore",    required_tool: "stone_pickaxe",  drops: ["raw_copper"],    light_emit: 0 },
	{ name: "gold_ore",      required_tool: "iron_pickaxe",   drops: ["raw_gold"],      light_emit: 0 },
	{ name: "diamond_ore",   required_tool: "iron_pickaxe",   drops: ["diamond"],       light_emit: 0 },
	{ name: "redstone_ore",  required_tool: "iron_pickaxe",   drops: ["redstone"],      light_emit: 9 },
	{ name: "lapis_ore",     required_tool: "stone_pickaxe",  drops: ["lapis_lazuli"],  light_emit: 0 },
	{ name: "obsidian",      required_tool: "diamond_pickaxe", drops: ["obsidian"],     light_emit: 0,  notes: "Diamond+ only; takes 10s+ to mine." },
	{ name: "dirt",          required_tool: "shovel",         drops: ["dirt"],          light_emit: 0,  walkable: 1 },
	{ name: "grass_block",   required_tool: "shovel",         drops: ["dirt"],          light_emit: 0 },
	{ name: "sand",          required_tool: "shovel",         drops: ["sand"],          light_emit: 0,  notes: "Falls with gravity — never stand under it while mining." },
	{ name: "gravel",        required_tool: "shovel",         drops: ["gravel"],        light_emit: 0,  notes: "Falls with gravity." },
	{ name: "torch",         required_tool: "any",            drops: ["torch"],         light_emit: 14, walkable: 0 },
	{ name: "lantern",       required_tool: "wood_pickaxe",   drops: ["lantern"],       light_emit: 15 },
	{ name: "campfire",      required_tool: "axe",            drops: ["charcoal"],      light_emit: 15, notes: "Damages anyone walking through." },
	{ name: "water",         required_tool: "bucket",         drops: [],                light_emit: 0,  walkable: 0, notes: "Use to escape mobs / hydrate farmland." },
	{ name: "lava",          required_tool: "bucket",         drops: [],                light_emit: 15, walkable: 0, notes: "Instant death. Never walk near without water bucket." },
	{ name: "crafting_table",required_tool: "axe",            drops: ["crafting_table"], light_emit: 0, notes: "Essential — first crafting target." },
	{ name: "furnace",       required_tool: "wood_pickaxe",   drops: ["furnace"],       light_emit: 13, notes: "Light value 13 when lit." },
];

// Starter lessons — hard-coded survival rules that shouldn't have to be
// re-learned every server. Confidence is high (0.9) for rules taken from
// the wiki-derived knowledge in docs/.
const STARTER_LESSONS = [
	{ text: "Don't attack hostiles with fists at night. Flee, shelter, or pillar up instead.",
		category: "combat", trigger_hostile: null, avoid_skill: "attack", prefer_skill: "survive.flee",
		confidence: 0.9, source: "rule", source_ref: "docs/minecraft-knowledge.md#mobs" },
	{ text: "Creeper within 5 blocks = critical danger. Never engage near base or chests.",
		category: "combat", trigger_hostile: "creeper", avoid_skill: "attack creeper", prefer_skill: "survive.flee",
		confidence: 0.95, source: "rule", source_ref: "docs/minecraft-knowledge.md#mobs" },
	{ text: "Skeleton in open ground = retreat to cover. Bow knockback kills you in a few hits.",
		category: "combat", trigger_hostile: "skeleton", avoid_skill: "attack skeleton",
		confidence: 0.85, source: "rule", source_ref: "docs/minecraft-knowledge.md#mobs" },
	{ text: "Spider — pillar up 2 blocks with dirt. Spiders can't climb a 2-block overhang.",
		category: "combat", trigger_hostile: "spider", prefer_skill: "recovery.tunnel-out",
		confidence: 0.85, source: "rule", source_ref: "docs/minecraft-knowledge.md#mobs" },
	{ text: "Enderman — don't look at the head, don't hit. Just walk away.",
		category: "combat", trigger_hostile: "enderman", avoid_skill: "attack enderman",
		confidence: 0.9, source: "rule", source_ref: "docs/minecraft-knowledge.md#mobs" },
	{ text: "At night without shelter — dig 2 blocks into ground and cap with dirt. Survive until day.",
		category: "survival", trigger_situation: "night-no-shelter",
		confidence: 0.8, source: "rule", source_ref: "docs/minecraft-knowledge.md" },
	{ text: "Before any cave/deep mining: have a wood pickaxe, food, torches, and a return path.",
		category: "survival", confidence: 0.85, source: "rule", source_ref: "docs/minecraft-knowledge.md" },
	{ text: "First crafting target — 4 logs → 16 planks → crafting table → wooden axe + sword. Always.",
		category: "crafting", confidence: 0.95, source: "rule", source_ref: "docs/minecraft-knowledge.md" },
	{ text: "Cobblestone needs at least a wood pickaxe — mining stone with fists drops nothing.",
		category: "crafting", trigger_skill: "gather.stone", confidence: 0.95, source: "rule" },
	{ text: "Sleep in a bed at night to skip phantoms and reset spawn. Bed needs 3 wool + 3 planks.",
		category: "survival", confidence: 0.85, source: "rule" },
	{ text: "Pathfinder stuck for 6s usually means terrain is unfavourable — back off and try a different direction rather than retry.",
		category: "pathing", confidence: 0.7, source: "rule", source_ref: "v0.2.0 observations" },
	{ text: "If gather.logs times out repeatedly in one area, move ≥ 32 blocks before trying again.",
		category: "pathing", trigger_skill: "gather.logs", confidence: 0.8, source: "rule" },
];

function loadRecipesJson() {
	try {
		const raw = readFileSync(RECIPES_JSON, "utf8");
		return JSON.parse(raw);
	} catch (e) {
		warn("knowledge", `recipes seed: ${e?.message ?? e}; skipping`);
		return null;
	}
}

export function seed() {
	if (!isAvailable()) return { ok: false, reason: "store unavailable" };
	const db = getStore();
	const now = Date.now();

	const tx = db.transaction(() => {
		const recipesData = loadRecipesJson();
		const recipeRows = recipesData?.recipes ?? [];
		const insertRecipe = db.prepare(`
			INSERT INTO recipes (name, shape, shapeless, yields, requires_table, source, source_url, updated_at)
			VALUES (@name, @shape, @shapeless, @yields, @requires_table, @source, @source_url, @updated_at)
			ON CONFLICT(name) DO UPDATE SET
				shape          = excluded.shape,
				shapeless      = excluded.shapeless,
				yields         = excluded.yields,
				requires_table = excluded.requires_table,
				updated_at     = excluded.updated_at
		`);
		for (const r of recipeRows) {
			insertRecipe.run({
				name: r.name,
				shape: JSON.stringify(r.shape ?? []),
				shapeless: r.shapeless ? 1 : 0,
				yields: r.yields ?? 1,
				requires_table: r.requires_table ?? 1,
				source: "seed:docs",
				source_url: recipesData?.sources?.[0] ?? null,
				updated_at: now,
			});
		}

		const insertMob = db.prepare(`
			INSERT INTO mob_intel (name, hostility, threat_level, approach_range, burns_in_sun, ranged,
			                       weakness, drops, verdict_no_weapon, verdict_with_sword, notes, source, updated_at)
			VALUES (@name, @hostility, @threat_level, @approach_range, @burns_in_sun, @ranged,
			        @weakness, @drops, @verdict_no_weapon, @verdict_with_sword, @notes, @source, @updated_at)
			ON CONFLICT(name) DO UPDATE SET
				hostility          = excluded.hostility,
				threat_level       = excluded.threat_level,
				approach_range     = excluded.approach_range,
				burns_in_sun       = excluded.burns_in_sun,
				ranged             = excluded.ranged,
				weakness           = excluded.weakness,
				drops              = excluded.drops,
				verdict_no_weapon  = excluded.verdict_no_weapon,
				verdict_with_sword = excluded.verdict_with_sword,
				notes              = excluded.notes,
				updated_at         = excluded.updated_at
		`);
		for (const m of MOB_INTEL) {
			insertMob.run({
				name: m.name,
				hostility: m.hostility,
				threat_level: m.threat_level,
				approach_range: m.approach_range ?? null,
				burns_in_sun: m.burns_in_sun ? 1 : 0,
				ranged: m.ranged ? 1 : 0,
				weakness: m.weakness ?? null,
				drops: JSON.stringify(m.drops ?? []),
				verdict_no_weapon: m.verdict_no_weapon ?? null,
				verdict_with_sword: m.verdict_with_sword ?? null,
				notes: m.notes ?? null,
				source: "seed:docs",
				updated_at: now,
			});
		}

		const insertBlock = db.prepare(`
			INSERT INTO block_intel (name, required_tool, drops, light_emit, walkable, notes, source, updated_at)
			VALUES (@name, @required_tool, @drops, @light_emit, @walkable, @notes, @source, @updated_at)
			ON CONFLICT(name) DO UPDATE SET
				required_tool = excluded.required_tool,
				drops         = excluded.drops,
				light_emit    = excluded.light_emit,
				walkable      = excluded.walkable,
				notes         = excluded.notes,
				updated_at    = excluded.updated_at
		`);
		for (const b of BLOCK_INTEL) {
			insertBlock.run({
				name: b.name,
				required_tool: b.required_tool ?? null,
				drops: JSON.stringify(b.drops ?? []),
				light_emit: b.light_emit ?? 0,
				walkable: b.walkable ?? 1,
				notes: b.notes ?? null,
				source: "seed:docs",
				updated_at: now,
			});
		}

		// Starter lessons — only insert if no row with the same text exists.
		// Lessons don't have a UNIQUE constraint on text (Pi-extracted ones
		// can rephrase), so dedupe explicitly.
		const findLesson = db.prepare("SELECT id FROM lessons WHERE text = ? LIMIT 1");
		const insertLesson = db.prepare(`
			INSERT INTO lessons (ts, text, category, trigger_skill, trigger_hostile, trigger_situation,
			                     avoid_skill, prefer_skill, confidence, applied_count, succeeded_count,
			                     source, source_ref)
			VALUES (@ts, @text, @category, @trigger_skill, @trigger_hostile, @trigger_situation,
			        @avoid_skill, @prefer_skill, @confidence, 0, 0, @source, @source_ref)
		`);
		for (const l of STARTER_LESSONS) {
			if (findLesson.get(l.text)) continue;
			insertLesson.run({
				ts: now,
				text: l.text,
				category: l.category,
				trigger_skill: l.trigger_skill ?? null,
				trigger_hostile: l.trigger_hostile ?? null,
				trigger_situation: l.trigger_situation ?? null,
				avoid_skill: l.avoid_skill ?? null,
				prefer_skill: l.prefer_skill ?? null,
				confidence: l.confidence ?? 0.5,
				source: l.source ?? "rule",
				source_ref: l.source_ref ?? null,
			});
		}
	});

	try {
		tx();
		const counts = countRows();
		info("knowledge", `seed complete: ${counts.recipes} recipes, ${counts.mobs} mobs, ${counts.blocks} blocks, ${counts.lessons} lessons`);
		return { ok: true, counts };
	} catch (e) {
		warn("knowledge", `seed failed: ${e?.message ?? e}`);
		return { ok: false, reason: e?.message ?? String(e) };
	}
}

function countRows() {
	const db = getStore();
	const q = (sql) => db.prepare(sql).get().n;
	return {
		recipes: q("SELECT COUNT(*) AS n FROM recipes"),
		mobs:    q("SELECT COUNT(*) AS n FROM mob_intel"),
		blocks:  q("SELECT COUNT(*) AS n FROM block_intel"),
		lessons: q("SELECT COUNT(*) AS n FROM lessons"),
	};
}

export { countRows as __countRowsForTests };
