import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGameDataFromDir } from '../../src/datasets/gamedata.ts';
import { buildRecipes, writeRecipes, foreverItems, learnFrom, CONVERSION_ID_BASE, type BlizzardRecipe, type BuiltRecipe } from '../../src/datasets/recipes.ts';
import { openDb } from '../../src/store/db.ts';
import { tempDir } from '../helpers.ts';

/**
 * Every expected number here was read by hand from the real wago CSV rows (build 1.60.1.71037) and Blizzard's
 * recipe responses (November 23), both cut into tests/fixtures. Trainer ranks are the real EG Link values:
 * Cerulean Dye (spell 1249630) Alchemy 40, Copper Chain Belt (2661) Blacksmithing 30, Minor Healing Potion (1244431) First Aid 1.
 */
const game = loadGameDataFromDir(fileURLToPath(new URL('../fixtures/wago', import.meta.url)), '1.60.1.71037');
const blizzard = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/blizzard-recipes.json', import.meta.url)), 'utf8')) as { professions: Array<{ id: number; name: string }>; recipes: BlizzardRecipe[] };
const trainerRanks = new Map([[1249630, 40], [2661, 30], [1244431, 1]]);
// In Forever if the game's item table has it; the fixture leaves Draught of Tongues (2460) out, as the real table does.
const exists = (id: number) => game.items.has(id);
const { recipes, report } = buildRecipes(game, blizzard, { trainerRanks, exists });
const R = (id: number): BuiltRecipe => { const r = recipes.find(x => x.id === id); if (!r) throw new Error(`recipe ${id} missing`); return r; };

describe('recipes from the game tables, checked by hand against the real rows', () => {
  it('Smelt Copper (3324): 1 Copper Ore makes 1 Copper Bar, 3 s, both sources agree, learned automatically at 1 (AcquireMethod 1), not at yellow 25', () => {
    expect(R(3324)).toMatchObject({ spellId: 2657, craftedItemId: 2840, qtyMin: 1, qtyMax: 1, reagents: [{ itemId: 2770, quantity: 1 }], castMs: 3000,
      source: 'both', disagreement: null, yellow: 25, green: 48, grey: 70, learnSkill: 1, learnSource: 'auto', cooldownMs: null, randomYield: false, live: true });
  });
  it('Minor Healing Potion (54191) is First Aid in Forever and needs an Empty Vial; trainer teaches it at 1', () => {
    expect(R(54191)).toMatchObject({ profession: 'First Aid', craftedItemId: 118,
      reagents: [{ itemId: 3371, quantity: 1 }, { itemId: 2678, quantity: 1 }, { itemId: 2447, quantity: 1 }], learnSkill: 1, learnSource: 'trainer_alliance' });
  });
  it('Linen Bandage (1838): 1 Linen Cloth makes 1 Linen Bandage', () => {
    expect(R(1838)).toMatchObject({ craftedItemId: 1251, reagents: [{ itemId: 2589, quantity: 1 }], yellow: 30, grey: 60, source: 'both', disagreement: null });
  });
  it('Cerulean Dye (54453): 2 Frilled Lichen and 1 Empty Vial make 1, 5 s cast, trainer at Alchemy 40', () => {
    expect(R(54453)).toMatchObject({ spellId: 1249630, profession: 'Alchemy', craftedItemId: 249409, qtyMin: 1, qtyMax: 1,
      reagents: [{ itemId: 249399, quantity: 2 }, { itemId: 3371, quantity: 1 }], castMs: 5000, learnSkill: 40, learnSource: 'trainer_alliance', yellow: 50, disagreement: null });
  });
  it('White Wedding Dress (6622) keeps Bleach, and the Blizzard disagreement is recorded', () => {
    const r = R(6622);
    expect(r.reagents).toEqual([{ itemId: 4339, quantity: 5 }, { itemId: 8343, quantity: 3 }, { itemId: 2324, quantity: 1 }]);
    expect(r.source).toBe('both');
    expect(r.disagreement).toBe('reagents: wago 4339x5, 8343x3, 2324x1; blizzard 4339x5, 8343x3');
  });
  it('Coarse Dynamite (2427) has a random yield: wago 2 plus or minus 1, Blizzard 1 to 4, so flagged, the whole numbers from Blizzard stored, the disagreement kept', () => {
    expect(R(2427)).toMatchObject({ craftedItemId: 4365, randomYield: true, qtyMin: 1, qtyMax: 4, disagreement: 'yield: wago 1 to 3, blizzard 1 to 4' });
  });
  it('Large Copper Bomb (2432) is random too (variance 0.67)', () => {
    expect(R(2432).randomYield).toBe(true);
    expect(Number.isInteger(R(2432).qtyMin) && Number.isInteger(R(2432).qtyMax)).toBe(true);
  });
  it('Runecloth Bag (10401) needs Cerulean Dye in Forever', () => {
    expect(R(10401).reagents).toEqual([{ itemId: 14048, quantity: 5 }, { itemId: 8170, quantity: 2 }, { itemId: 14341, quantity: 1 }, { itemId: 249430, quantity: 4 }, { itemId: 249409, quantity: 2 }]);
    expect(R(10401).craftedItemId).toBe(14046);
  });
  it('Transmute: Iron to Gold (6020) has its own 1 hour cooldown', () => {
    expect(R(6020)).toMatchObject({ craftedItemId: 3577, reagents: [{ itemId: 3575, quantity: 1 }], cooldownMs: 3_600_000, cooldownCategory: null });
  });
  it('Transmute: Arcanite (9840, 47 h) and Air to Fire (9943, 23 h) share cooldown category 310', () => {
    expect(R(9840)).toMatchObject({ craftedItemId: 12360, cooldownMs: 169_200_000, cooldownCategory: 310 });
    expect(R(9943)).toMatchObject({ cooldownMs: 82_800_000, cooldownCategory: 310 });
  });
  it('Mooncloth (10487): 2 Felcloth make 1, 95 hour cooldown of its own, 60 s base cast', () => {
    expect(R(10487)).toMatchObject({ craftedItemId: 14342, reagents: [{ itemId: 14256, quantity: 2 }], cooldownMs: 342_000_000, cooldownCategory: null, castMs: 60000 });
  });
  it('Smelt Bronze (1600) and Rough Copper Bomb (2418) make 2 each, a fixed multi yield', () => {
    expect(R(1600)).toMatchObject({ craftedItemId: 2841, qtyMin: 2, qtyMax: 2, randomYield: false, reagents: [{ itemId: 2840, quantity: 1 }, { itemId: 3576, quantity: 1 }] });
    expect(R(2418)).toMatchObject({ craftedItemId: 4360, qtyMin: 2, qtyMax: 2, randomYield: false });
  });
  it('learn skill: Copper Chain Belt (1632) from its trainer at 30, not its yellow 70', () => {
    expect(R(1632)).toMatchObject({ learnSkill: 30, learnSource: 'trainer_alliance', yellow: 70, grey: 110, teachItemId: null });
  });
  it('Bolt of Linen Cloth (2359) is learned automatically at 1 (AcquireMethod 1), not at its yellow 25', () => {
    expect(R(2359)).toMatchObject({ craftedItemId: 2996, reagents: [{ itemId: 2589, quantity: 2 }], learnSkill: 1, learnSource: 'auto', yellow: 25 });
  });
  it('Instant Poison (4807) comes from wago only, under Poisons', () => {
    expect(R(4807)).toMatchObject({ source: 'wago', profession: 'Poisons', craftedItemId: 6947, reagents: [{ itemId: 2928, quantity: 1 }, { itemId: 3371, quantity: 1 }] });
  });
  it('Smelt Obsidian-Infused Thorium Bar (51701) comes from wago only', () => {
    expect(R(51701)).toMatchObject({ source: 'wago', profession: 'Mining', craftedItemId: 234003, reagents: [{ itemId: 12655, quantity: 2 }, { itemId: 22203, quantity: 2 }] });
  });
  it('Centaur Hoofwarmers (60362) comes from Blizzard only', () => {
    expect(R(60362)).toMatchObject({ source: 'blizzard', spellId: null, craftedItemId: 274490, reagents: [{ itemId: 4304, quantity: 12 }, { itemId: 8343, quantity: 2 }], learnSkill: null });
  });
  it('Elixir of Minor Defense (4178), Light Armor Kit (1356), Brilliant Smallfish (4353) agree across sources', () => {
    expect(R(4178)).toMatchObject({ craftedItemId: 5997, reagents: [{ itemId: 765, quantity: 1 }, { itemId: 2447, quantity: 1 }, { itemId: 3371, quantity: 1 }], disagreement: null });
    expect(R(1356)).toMatchObject({ craftedItemId: 2304, reagents: [{ itemId: 2318, quantity: 1 }], disagreement: null });
    expect(R(4353)).toMatchObject({ craftedItemId: 6290, reagents: [{ itemId: 6291, quantity: 1 }], disagreement: null });
  });
  it('an enchant (4289) has reagents and no product in both sources', () => {
    expect(R(4289)).toMatchObject({ craftedItemId: null, reagents: [{ itemId: 247786, quantity: 1 }], source: 'both', disagreement: null });
  });
  it('test recipes are dropped and counted: Smelt Copper (Test)', () => {
    expect(recipes.some(r => r.id === 53851)).toBe(false);
    expect(report.dropped.test).toEqual([{ id: 53851, name: 'Smelt Copper (Test)' }]);
  });
  it('Season of Discovery recipes are dropped and counted: Elixir of Coalesced Regret (49255)', () => {
    expect(recipes.some(r => r.id === 49255)).toBe(false);
    expect(report.dropped.seasonOfDiscovery).toBe(1);
  });
  it('live filter: Draught of Tongues (1384) makes an item Forever lacks, so it is kept but not live', () => {
    expect(R(1384)).toMatchObject({ craftedItemId: 2460, live: false });
    expect(R(54453).live).toBe(true);
    expect(report.notLive).toBe(recipes.filter(r => !r.live).length);
  });
  it('the report lists every disagreement and every random yield', () => {
    expect(report.disagreements.map(d => d.id).sort((a, b) => a - b)).toEqual([2427, 2432, 6622]);
    expect(report.randomYield.map(d => d.id).sort((a, b) => a - b)).toEqual([2427, 2432]);
  });
});

/**
 * Teaching items, read by hand from the real rows of build 1.60.1.71037: ItemEffect TriggerType 6 casts the craft
 * spell, ItemXItemEffect links it to the item, ItemSparse.RequiredSkillRank is the rank it teaches at.
 * Pattern: Fine Leather Boots 2406 -> spell 2158 at 65 (yellow 95). Recipe: Swiftness Potion 2555 -> spell 2335 at 60
 * (yellow 90). Pattern: Mooncloth 14526 -> 18560 at 230 (yellow 270). Pattern: Runecloth Bag 14468 -> 18405 at 215.
 */
describe('where a recipe is learned (round 2 fix 1)', () => {
  it('the game tables link a teaching item to its craft spell by id: Pattern: Mooncloth 14526 teaches 18560', () => {
    expect(game.teachers.get(18560)).toEqual([14526]);
    expect(game.items.get(14526)).toMatchObject({ name: 'Pattern: Mooncloth', requiredSkill: 197, requiredSkillRank: 230 });
  });
  it('Fine Leather Boots (1359) is learned from Pattern: Fine Leather Boots at 65, not at its yellow 95', () => {
    expect(R(1359)).toMatchObject({ spellId: 2158, learnSkill: 65, learnSource: 'item', teachItemId: 2406, teachSkill: 65, yellow: 95 });
  });
  it('Swiftness Potion (1383) is learned from Recipe: Swiftness Potion at 60, not at its yellow 90', () => {
    expect(R(1383)).toMatchObject({ spellId: 2335, learnSkill: 60, learnSource: 'item', teachItemId: 2555, teachSkill: 60, yellow: 90 });
  });
  it('Mooncloth (10487) at 230 and Runecloth Bag (10401) at 215 from their patterns', () => {
    expect(R(10487)).toMatchObject({ learnSkill: 230, learnSource: 'item', teachItemId: 14526, yellow: 270 });
    expect(R(10401)).toMatchObject({ learnSkill: 215, learnSource: 'item', teachItemId: 14468, yellow: 230 });
  });
  it('an Alliance trainer below the item wins; the item is still recorded', () => {
    const r = buildRecipes(game, blizzard, { trainerRanks: new Map([[2158, 50]]), exists });
    expect(r.recipes.find(x => x.id === 1359)).toMatchObject({ learnSkill: 50, learnSource: 'trainer_alliance', teachItemId: 2406, teachSkill: 65 });
  });
  it('a teaching item not in Forever is not used', () => {
    const r = buildRecipes(game, blizzard, { trainerRanks, exists: id => id !== 2406 && game.items.has(id) });
    expect(r.recipes.find(x => x.id === 1359)).toMatchObject({ learnSource: 'yellow', learnSkill: 95, teachItemId: null });
  });
  it('only Horde trainers teach it: their rank, flagged trainer_horde_only; with none at all, yellow is the last guess', () => {
    // Coarse Dynamite (2427, spell 3931) has no teaching item and AcquireMethod 0 in the real rows; the Horde rank is made up.
    const h = buildRecipes(game, blizzard, { trainerRanks, hordeRanks: new Map([[3931, 75]]), exists });
    expect(h.recipes.find(x => x.id === 2427)).toMatchObject({ learnSkill: 75, learnSource: 'trainer_horde_only' });
    expect(R(2427)).toMatchObject({ learnSkill: 90, learnSource: 'yellow', yellow: 90 });
  });
  it('the lowest of auto, Alliance trainer and item wins, ties go to auto then trainer; Horde and yellow only as fallbacks', () => {
    expect(learnFrom({ trainer: 30, teach: 30, auto: 30, yellow: 70 })).toEqual({ skill: 30, source: 'auto' });
    expect(learnFrom({ trainer: 30, teach: 30, yellow: 70 })).toEqual({ skill: 30, source: 'trainer_alliance' });
    expect(learnFrom({ trainer: 40, teach: 30, horde: 1 })).toEqual({ skill: 30, source: 'item' });
    expect(learnFrom({ horde: 1, yellow: 70 })).toEqual({ skill: 1, source: 'trainer_horde_only' });
    expect(learnFrom({ yellow: 70 })).toEqual({ skill: 70, source: 'yellow' });
    expect(learnFrom({})).toEqual({ skill: null, source: null });
  });
  it('every profession recipe with thresholds has a learn source; the report counts them', () => {
    const prof = recipes.filter(r => r.kind === 'profession');
    expect(prof.filter(r => r.yellow != null && r.learnSource == null)).toEqual([]);
    const l = report.learn;
    expect(l.trainer_alliance + l.trainer_horde_only + l.item + l.auto + l.yellow + l.none).toBe(prof.length);
    expect(l.conversion).toBe(recipes.filter(r => r.kind === 'conversion').length);
    expect(recipes.filter(r => r.learnSource == null).map(r => r.id)).toEqual(prof.filter(r => r.learnSource == null).map(r => r.id));
    expect(l.teachItem).toBe(prof.filter(r => r.teachItemId != null).length);
  });
  it('writes teach_item_id, teach_skill and learn_source', () => {
    const db = openDb(tempDir(), ':memory:');
    writeRecipes(db, recipes, { version: 'test', note: 'test' });
    expect(db.prepare('SELECT learn_skill, learn_source, teach_item_id, teach_skill FROM recipes WHERE id = 1383').get()).toEqual({ learn_skill: 60, learn_source: 'item', teach_item_id: 2555, teach_skill: 60 });
    expect(db.prepare('SELECT learn_source FROM recipes WHERE id = 3324').get()).toEqual({ learn_source: 'auto' });
  });
});

describe('conversions from item use spells', () => {
  it('Lesser Magic Essence: 3 in (2 reagents plus the item used up), 1 Greater out, as the spell text says', () => {
    expect(R(CONVERSION_ID_BASE + 13361)).toMatchObject({ kind: 'conversion', profession: 'Conversion', spellId: 13361, craftedItemId: 10939, qtyMin: 1, qtyMax: 1, reagents: [{ itemId: 10938, quantity: 3 }], live: true });
  });
  it('Greater Magic Essence: 1 in, 3 Lesser out', () => {
    expect(R(CONVERSION_ID_BASE + 13362)).toMatchObject({ craftedItemId: 10938, qtyMin: 3, reagents: [{ itemId: 10939, quantity: 1 }] });
  });
  it('Waylaid Supplies is left out: its spell text does not state the 20 bars', () => {
    expect(recipes.some(r => r.spellId === 427020)).toBe(false);
    expect(report.conversions.unproven).toEqual([{ spellId: 427020, name: 'Replace Supplies', why: 'spell text does not state the counts 20' }]);
  });
  it('a conversion whose items are not in Forever is left out', () => {
    const r = buildRecipes(game, blizzard, { trainerRanks, exists: id => id !== 10939 && game.items.has(id) });
    expect(r.recipes.some(x => x.kind === 'conversion')).toBe(false);
    expect(r.report.conversions.notLive).toBe(2);
  });
  it('a conversion touching an item that cannot be traded (quest or pickup bound) is left out', () => {
    const items = new Map(game.items).set(10938, { ...game.items.get(10938)!, bonding: 4 });
    const r = buildRecipes({ ...game, items }, blizzard, { trainerRanks, exists: id => items.has(id) });
    expect(r.recipes.some(x => x.kind === 'conversion')).toBe(false);
    expect(r.report.conversions.bound).toBe(2);
  });
  it('bound if EITHER source says so: the live API binds Lesser Magic Essence on pickup while ItemSparse says unbound (a server hotfix)', () => {
    expect(game.items.get(10938)?.bonding).toBe(0);
    const r = buildRecipes(game, blizzard, { trainerRanks, exists, apiBinding: id => (id === 10938 ? 'ON_ACQUIRE' : null) });
    expect(r.recipes.some(x => x.kind === 'conversion')).toBe(false);
    expect(r.report.conversions).toMatchObject({ bound: 2, boundByApiOnly: 2 });
    const q = buildRecipes(game, blizzard, { trainerRanks, exists, apiBinding: id => (id === 10939 ? 'QUEST' : 'ON_USE') });
    expect(q.report.conversions.bound).toBe(2);
    const free = buildRecipes(game, blizzard, { trainerRanks, exists, apiBinding: () => 'ON_EQUIP' });
    expect(free.report.conversions.kept.length).toBe(2);
  });
});

describe('writing recipes and the Forever item rule', () => {
  it('stores every new column and the reagents', () => {
    const db = openDb(tempDir(), ':memory:');
    writeRecipes(db, recipes, { version: 'test', note: 'test' });
    const row = db.prepare('SELECT * FROM recipes WHERE id = 2427').get() as Record<string, unknown>;
    expect(row).toMatchObject({ spell_id: 3931, random_yield: 1, live: 1, kind: 'profession', source: 'both', disagreement: 'yield: wago 1 to 3, blizzard 1 to 4' });
    const dress = db.prepare('SELECT item_id, quantity FROM recipe_reagents WHERE recipe_id = 6622 ORDER BY item_id').all();
    expect(dress).toEqual([{ item_id: 2324, quantity: 1 }, { item_id: 4339, quantity: 5 }, { item_id: 8343, quantity: 3 }]);
    expect(db.prepare(`SELECT kind FROM recipes WHERE id = ?`).get(CONVERSION_ID_BASE + 13361)).toEqual({ kind: 'conversion' });
  });
  it('an item exists in Forever when Blizzard Forever has it, the game table has it, or a tracked house listed it', () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO houses (id, name, faction, cut, tracked) VALUES (111, 'A', 'alliance', 0.05, 1), (999, 'Old', 'alliance', 0.05, 0);
      INSERT INTO items (id, status, fetched_at, data_source) VALUES (1, 200, 0, 'forever'), (2, 200, 0, 'classic1x'), (3, 200, 0, NULL);
      INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder)
        VALUES (1, 111, 720, 0, 10, 1, 1, 1, 1, '[]'), (2, 999, 721, 0, 10, 1, 1, 1, 1, '[]');`);
    const has = foreverItems(db, game);
    expect([1, 2, 3, 720, 721, 3371, 2460].map(has)).toEqual([true, false, true, true, false, true, false]);
  });
});
