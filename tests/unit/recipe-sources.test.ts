import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { mergeTrainers } from '../../src/datasets/eglink.ts';
import { recipeSources } from '../../src/craft/recipeSources.ts';
import { levelingPlan } from '../../src/craft/leveling.ts';
import type { PriceBook } from '../../src/analysis/prices.ts';
import { tempDir } from '../helpers.ts';

// Shapes copied from real EG Link records (trainers 1.60.1.70888, Saru Steelfury and Gelman Stonehand).
const horde = { name: 'Saru Steelfury', tradeskill: true, trainerType: 2, positions: [{ uiMap: 1454, mapX: 0.8214, mapY: 0.2304 }],
  services: {
    '3100': { spellId: 3100, name: 'Journeyman Blacksmith', skill: 'Blacksmithing', skillRank: 50, costs: { '5': 500 } },
    '2665': { spellId: 2665, name: 'Copper Chain Belt', skill: 'Blacksmithing', skillRank: 30, costs: { '5': 100, '6': 90 } },
  } };
const alliance = { name: 'Gelman Stonehand', tradeskill: true, trainerType: 2, positions: [{ uiMap: 1453, mapX: 0.5, mapY: 0.6 }],
  services: { '2658': { spellId: 2658, name: 'Smelt Silver', skill: 'Mining', skillRank: 75, costs: { '5': 200 } } } };
const classTrainer = { name: 'Khelden Bremen', tradeskill: false, trainerType: 0, services: { '116': { spellId: 116, name: 'Frostbolt', costs: { '5': 100 } } } };

function db() {
  const d = openDb(tempDir(), ':memory:');
  const merged = mergeTrainers([{ build: '1.60.1.70888', trainers: { '3355': horde, '5513': alliance, '198': classTrainer },
    npcs: { '5513': { name: 'Gelman Stonehand', side: 'Alliance' }, '3355': { name: 'Saru Steelfury', side: 'Horde' } }, creatures: {} }]);
  const it = d.prepare(`INSERT INTO trainer_spells (npc_id, npc_name, faction, zone, x, y, map_id, spell_id, name, skill, skill_rank, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of merged) it.run(t.npcId, t.npcName, t.faction, t.zone, t.x, t.y, t.uiMap, t.spellId, t.name, t.skill, t.skillRank, t.cost);
  return { d, merged };
}

describe('recipe sources', () => {
  it('keeps profession trainers only, with base cost and faction', () => {
    const { merged } = db();
    expect(merged.some(m => m.name === 'Frostbolt')).toBe(false);
    const belt = merged.find(m => m.name === 'Copper Chain Belt')!;
    expect(belt).toMatchObject({ faction: 'horde', cost: 100, skillRank: 30, x: 82.1, y: 23 });
    expect(merged.find(m => m.name === 'Smelt Silver')!.faction).toBe('alliance');
  });
  it('uses an Alliance trainer when one is recorded', () => {
    const { d } = db();
    const r = recipeSources(d, 'Smelt Silver', 'Mining');
    expect(r.how).toBe('trainer');
    expect(r.sources[0]).toMatchObject({ who: 'Gelman Stonehand', unconfirmed: false, cost: 200 });
  });
  it('never sends Chip to a Horde trainer: cost and rank kept, place marked unconfirmed', () => {
    const { d } = db();
    const r = recipeSources(d, 'Copper Chain Belt', 'Blacksmithing');
    expect(r.cost).toBe(100);
    expect(r.skillRank).toBe(30);
    expect(r.sources.every(s => s.unconfirmed && s.who !== 'Saru Steelfury')).toBe(true);
    expect(r.sources.some(s => s.who === 'Brikk Keencraft')).toBe(false); // Artisan only
  });
  it('finds a recipe sold as plans by an Alliance usable vendor, and never a Horde one', () => {
    const { d } = db();
    d.exec(`INSERT INTO items (id, name, name_source, status, fetched_at) VALUES (7975, 'Plans: Heavy Mithril Pants', 'eglink', 0, 0);
      INSERT INTO vendor_items (npc_id, npc_name, faction, zone, x, y, map_id, item_id, price, price_by_standing, units_per_purchase, limited, standing_required)
      VALUES (1, 'Horde Smith', 'horde', 'Orgrimmar', 1, 1, 1454, 7975, 500, '{}', 1, 0, '5'),
             (2, 'Neutral Smith', 'neutral', 'Booty Bay', 2, 2, 1434, 7975, 600, '{}', 1, 1, '4');`);
    const r = recipeSources(d, 'Heavy Mithril Pants', 'Blacksmithing');
    expect(r.how).toBe('vendor');
    expect(r.sources.map(s => s.who)).toEqual(['Neutral Smith']);
    expect(r.cost).toBe(600);
  });
  it('says unknown with a lookup link when nothing records it, and start for a first recipe', () => {
    const { d } = db();
    const r = recipeSources(d, 'Bold Dirk', 'Blacksmithing', { guideNote: 'New in Forever' });
    expect(r.how).toBe('unknown');
    expect(r.note).toBe('New in Forever');
    expect(r.lookup).toContain('Bold%20Dirk');
    expect(recipeSources(d, 'Rough Sharpening Stone', 'Blacksmithing', { guideNote: 'Known as soon as you learn Blacksmithing' }).how).toBe('start');
    // A low minimum rank in the game tables is not proof: Silver Skeleton Key is learned at 75.
    expect(recipeSources(d, 'Silver Skeleton Key', 'Blacksmithing').how).toBe('unknown');
  });
  it('the leveling plan lists recipes in order, the Journeyman rank when the plan crosses 75, and the learn cost', () => {
    const { d } = db();
    d.exec(`INSERT INTO recipes (id, name, profession, crafted_item_id, qty_min, qty_max, learn_skill, yellow, green, grey) VALUES
      (1, 'Copper Chain Belt', 'Blacksmithing', 2851, 1, 1, 30, 70, 90, 110);
      INSERT INTO recipe_reagents VALUES (1, 2840, 6);`);
    const book: PriceBook = { houseId: 111, faction: 'alliance', houseName: 'Alliance 111', floor: new Map([[2840, { floor: 105, units: 9000, at: 0 }]]),
      sell: new Map(), binding: new Map(), names: new Map([[2840, 'Copper Bar']]), vendor: new Map() };
    const p = levelingPlan(d, book, 'Blacksmithing', 65, 80);
    expect(p.recipes.map(r => r.recipe)).toContain('Copper Chain Belt');
    expect(p.ranks).toEqual([expect.objectContaining({ name: 'Journeyman Blacksmithing', learnAt: 50, cost: 500, capBefore: 75 })]);
    expect(p.learnCost).toBe(600);
    expect(levelingPlan(d, book, 'Blacksmithing', 76, 80).ranks).toEqual([]);
  });
});
