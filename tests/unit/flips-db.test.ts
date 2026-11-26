import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/store/db.ts';
import { chipHouses } from '../../src/flips/houses.ts';
import { buildFlipInputs, recipeKey, TEACH_PREFIX } from '../../src/flips/inputs.ts';
import { runFlips, setupFor } from '../../src/flips/run.ts';
import { persistFlips } from '../../src/flips/persist.ts';
import type { Listing } from '../../src/analysis/aggregate.ts';
import { tempDir } from '../helpers.ts';
import { inputsOf, recipe, item } from './flips.fixture.ts';

let nid = 1;
const L = (itemId: number, price: number, qty = 1): Listing => ({ id: nid++, itemId, quantity: qty, unitPrice: price, timeLeft: 'LONG' });
const HOUR = 3600_000;

function db(): DB {
  const d = openDb(tempDir(), ':memory:');
  d.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES
    (110, 'Alliance Auction House', 'alliance', 0.05, 1, 0), (111, 'Alliance Auction House', 'alliance', 0.05, 1, 0),
    (113, 'Horde Auction House', 'horde', 0.05, 0, 0), (116, 'Blackwater Auction House', 'blackwater', 0.15, 1, 0),
    (117, 'Blackwater Auction House', 'blackwater', 0.15, 1, 0);
    INSERT INTO items (id, name, quality, sell_price, status, fetched_at, bonding, vendor_stack) VALUES
    (2589, 'Linen Cloth', 'COMMON', 20, 200, 0, 0, NULL), (2770, 'Copper Ore', 'COMMON', 5, 200, 0, 0, NULL), (2840, 'Copper Bar', 'COMMON', 10, 200, 0, 0, NULL),
    (3371, 'Empty Vial', 'COMMON', 1, 200, 0, 0, 5), (9999, 'Odd Thing', 'COMMON', 50, 200, 0, 0, NULL);
    INSERT INTO recipes (id, name, profession, crafted_item_id, qty_min, qty_max, learn_skill, spell_id) VALUES
    (2657, 'Smelt Copper', 'Mining', 2840, 1, 1, 1, 2657), (9001, 'Odd Bomb', 'Engineering', 9999, 1, 3, 1, NULL), (53851, 'Smelt Copper (Test)', 'Test Profession [DNT]', 2840, 1, 1, 1, NULL);
    INSERT INTO recipe_reagents VALUES (2657, 2770, 1), (9001, 2770, 1), (53851, 2770, 1);
    INSERT INTO vendor_items (npc_id, npc_name, faction, zone, item_id, price, units_per_purchase, limited, standing_required) VALUES
    (66, 'Tharynn Bouden', 'alliance', 'Elwynn Forest', 3371, 4, 5, 0, '5'), (3490, 'Hula''mahi', 'horde', 'The Barrens', 2770, 1, 1, 0, '4'),
    (777, 'Honored Only', 'alliance', 'Redridge', 2589, 1, 1, 0, '7');
    INSERT INTO trainer_spells (npc_id, npc_name, faction, zone, x, y, map_id, spell_id, name, skill, skill_rank, cost) VALUES
    (5513, 'Gelman Stonehand', 'alliance', 'Stormwind City', 51, 17, 1453, 2657, 'Smelt Copper', 'Mining', 1, 10);`);
  // A publish of both listing kinds every hour for the first 20 hours on houses 111 and 116, so the fresh gate passes.
  for (let h = 0; h <= 20; h++) for (const house of [111, 116]) publish(d, house, h * HOUR);
  return d;
}
function publish(d: DB, house: number, at: number, kinds = ['auctions', 'commodities']): void {
  for (const k of kinds) d.prepare('INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes) VALUES (?, ?, ?, ?, ?, 0, 0, 0)').run(house, k, `${k}-${at}`, at, at);
}
const market = (): Map<number, Listing[]> => new Map([
  [111, [L(2589, 10, 20), L(2770, 4, 30), L(2770, 20, 50)]],
  [110, [L(2589, 1, 500)]],
  [116, [L(2589, 11, 10)]],
]);

describe('chipHouses', () => {
  it('nothing pinned: house 111 alone', () => {
    expect(chipHouses(db()).map(h => h.id)).toEqual([111]);
  });
  it('his pinned Alliance and Blackwater houses; a pinned Horde house is ignored', () => {
    const d = db();
    d.exec('UPDATE houses SET pinned = 1 WHERE id IN (110, 116, 113)');
    expect(chipHouses(d).map(h => [h.id, h.faction, h.cut])).toEqual([[110, 'alliance', 0.05], [116, 'blackwater', 0.15]]);
  });
  it('a pinned Blackwater house alone still keeps 111 for Alliance; never two of one faction', () => {
    const d = db();
    d.exec('UPDATE houses SET pinned = 1 WHERE id IN (116, 117)');
    expect(chipHouses(d).map(h => h.id)).toEqual([111, 116]);
  });
});

describe('buildFlipInputs', () => {
  it('reads only Chip\'s houses, raw listings, usable vendors with their bundles, and flags old catalog rows', () => {
    const d = db();
    const inputs = buildFlipInputs(d, market(), 10 * HOUR);
    expect(inputs.problems).toEqual([]);
    expect([...inputs.listings.keys()]).toEqual([111]);
    expect(inputs.listings.get(111)!.get(2770)!.map(l => l.unitPrice)).toEqual([4, 20]);
    expect(inputs.vendors.get(3371)![0]).toMatchObject({ npcName: 'Tharynn Bouden', unitPrice: 4, bundle: 5 });
    expect(inputs.vendors.has(2770)).toBe(false); // Horde vendor
    expect(inputs.vendors.has(2589)).toBe(false); // needs Honored
    expect(inputs.recipes.find(r => r.id === 9001)!.randomYield).toBe(true); // 1 to 3 from an old catalog
    expect(inputs.recipes.find(r => r.id === 53851)!.live).toBe(false); // test profession row
  });
  it('a Chip house with no snapshot makes the run incomplete, never a silent partial list', () => {
    const d = db();
    d.exec('UPDATE houses SET pinned = 1 WHERE id = 116');
    const res = runFlips(buildFlipInputs(d, new Map([[111, [L(2589, 10, 20)]]]), 10 * HOUR));
    expect(res.report.complete).toBe(false);
    expect(res.report.incompleteReason).toMatch(/no snapshot for house 116/);
    expect(res.flips).toEqual([]);
  });
  it('data over 2 hours old makes the run incomplete, never a list from stale prices (round 1 M1)', () => {
    const d = db();
    // the newest publish is at 20 hours; at 22.5 hours it is 2.5 hours old
    const res = runFlips(buildFlipInputs(d, market(), 22.5 * HOUR));
    expect(res.report.complete).toBe(false);
    expect(res.report.incompleteReason).toMatch(/data is 2\.5 hours old on house 111/);
    expect(res.flips).toEqual([]);
    // at 21.5 hours it is 1.5 hours old: fresh enough
    expect(runFlips(buildFlipInputs(d, market(), 21.5 * HOUR)).report.complete).toBe(true);
  });
  it('a house missing one listing kind, or a raw file the caller could not read, makes the run incomplete (round 1 L5)', () => {
    const d = db();
    d.exec('DELETE FROM snapshots WHERE house_id = 111 AND kind = \'commodities\'');
    const res = runFlips(buildFlipInputs(d, market(), 10 * HOUR));
    expect(res.report.complete).toBe(false);
    expect(res.report.incompleteReason).toMatch(/house 111 has no commodities snapshot/);
    const d2 = db();
    const res2 = runFlips(buildFlipInputs(d2, market(), 10 * HOUR, ['house 111 commodities raw snapshot 36000000 is missing']));
    expect(res2.report.complete).toBe(false);
    expect(res2.report.incompleteReason).toMatch(/raw snapshot 36000000 is missing/);
    // publishes after `now` are never used: at 3.4 hours the newest is the one at 3 hours
    const early = buildFlipInputs(db(), market(), 3.4 * HOUR);
    expect(early.houses.find(h => h.id === 111)!.publishedAt).toBe(3 * HOUR);
  });
  it('time rate and gold on hand come from settings', () => {
    const d = db();
    expect(buildFlipInputs(d, market(), 10 * HOUR).settings).toMatchObject({ timeRate: 0, goldOnHand: null, horizonHours: 10, craftSessionMinutes: 30 });
    d.exec(`INSERT INTO settings (key, value) VALUES ('time_rate', '5000'), ('gold_on_hand', '12.5'), ('craft_session_minutes', '45')`);
    expect(buildFlipInputs(d, market(), 10 * HOUR).settings).toMatchObject({ timeRate: 5000, goldOnHand: 125000, horizonHours: 10, craftSessionMinutes: 45 });
  });
});

describe('persistFlips and the trends it feeds', () => {
  it('new, then live; a flip that does not come back is gone; history counts the hours open', () => {
    const d = db();
    const t1 = 10 * HOUR, t2 = 11 * HOUR, t3 = 12 * HOUR;
    const r1 = runFlips(buildFlipInputs(d, market(), t1));
    const key = 'auction_vendor:vendor:2589';
    expect(r1.flips.find(f => f.key === key)).toMatchObject({ opening: 'new', openHours72: 1 });
    persistFlips(d, r1, t1);
    expect(d.prepare('SELECT state FROM flips WHERE key = ?').get(key)).toMatchObject({ state: 'new' });
    const r2 = runFlips(buildFlipInputs(d, market(), t2));
    expect(r2.flips.find(f => f.key === key)).toMatchObject({ opening: null, openHours72: 2 });
    persistFlips(d, r2, t2);
    expect(d.prepare('SELECT state FROM flips WHERE key = ?').get(key)).toMatchObject({ state: 'live' });
    const r3 = runFlips(buildFlipInputs(d, new Map([[111, [L(2770, 40, 5)]]]), t3));
    persistFlips(d, r3, t3);
    expect(d.prepare('SELECT state, gone_at FROM flips WHERE key = ?').get(key)).toMatchObject({ state: 'gone', gone_at: t3 });
    expect((d.prepare('SELECT COUNT(*) n FROM flip_history WHERE key = ?').get(key) as { n: number }).n).toBe(2);
    expect((d.prepare('SELECT COUNT(*) n FROM flip_runs').get() as { n: number }).n).toBe(3);
  });
  it('an incomplete run writes its report and changes no flip', () => {
    const d = db();
    persistFlips(d, runFlips(buildFlipInputs(d, market(), HOUR)), HOUR);
    const before = d.prepare('SELECT key, state FROM flips ORDER BY key').all();
    const bad = runFlips(buildFlipInputs(d, new Map(), 2 * HOUR));
    persistFlips(d, bad, 2 * HOUR);
    expect(d.prepare('SELECT key, state FROM flips ORDER BY key').all()).toEqual(before);
    expect(d.prepare('SELECT complete FROM flip_runs WHERE at = ?').get(2 * HOUR)).toMatchObject({ complete: 0 });
  });
});

describe('setup for a craft', () => {
  it('from the trainer by spell id, else the item that teaches it', () => {
    const d = db();
    const inputs = buildFlipInputs(d, market(), HOUR);
    expect(setupFor(inputs.recipes.find(r => r.id === 2657)!, inputs)).toMatchObject({ skill: 'Mining', rank: 1, cost: 10, where: 'Gelman Stonehand, Stormwind City' });
    const pure = inputsOf({ listings: { 111: [] }, items: [item(6053, 'Recipe: Holy Protection Potion', 200), item(6051, 'Holy Protection Potion', 25)] });
    pure.recipeItems.set('holy protection potion', 6053);
    pure.vendors.set(6053, [{ npcId: 1, npcName: 'Alchemist Mallory', zone: 'Elwynn Forest', places: [], unitPrice: 100, bundle: 1, limited: true, minStanding: 4 }]);
    expect(setupFor(recipe(7255, 'Holy Protection Potion', 6051, [[2589, 1]], { learnSkill: 100 }), pure))
      .toMatchObject({ rank: 100, cost: 100, where: 'Recipe: Holy Protection Potion: 1s from Alchemist Mallory, Elwynn Forest', teachItem: { id: 6053 } });
  });
  it('teaching items by id first, any prefix by name as the fallback, with the auction price when listed (round 1 M4)', () => {
    const LIFE = 13488, RACK = 273096;
    const f = inputsOf({ listings: { 111: [L(LIFE, 450000, 1), L(RACK, 750, 1)] },
      items: [item(LIFE, 'Recipe: Transmute Life to Earth', 3750), item(RACK, 'Blueprint: Tanning Rack', 375), item(7076, 'Essence of Earth', 500), item(279941, 'Tanning Rack', 100)] });
    // linked by id (recipes.teach_item_id): the name differs ("Transmute: Life to Earth"), the link does not care
    expect(setupFor(recipe(9950, 'Transmute: Life to Earth', 7076, [[2589, 1]], { learnSkill: 275, teachItemId: LIFE }), f))
      .toMatchObject({ rank: 275, cost: 450000, auctionPrice: 450000, auctionHouseId: 111, teachItem: { id: LIFE, name: 'Recipe: Transmute Life to Earth' },
        where: 'Recipe: Transmute Life to Earth: 45g on the Alliance auction house' });
    // no id: a Blueprint: prefix matches by name, punctuation aside
    f.recipeItems.set(recipeKey('Tanning Rack'), RACK);
    expect(setupFor(recipe(57015, 'Tanning Rack', 279941, [[2589, 1]], { learnSkill: 125, profession: 'Leatherworking' }), f))
      .toMatchObject({ rank: 125, cost: 750, auctionPrice: 750, where: 'Blueprint: Tanning Rack: 7s 50c on the Alliance auction house' });
    expect(TEACH_PREFIX.exec('Blueprint: Tanning Rack')![2]).toBe('Tanning Rack');
    for (const p of ['Recipe', 'Pattern', 'Plans', 'Formula', 'Schematic', 'Blueprint', 'Manual']) expect(TEACH_PREFIX.test(`${p}: Thing`)).toBe(true);
    // listed and sold by a vendor: both named, the cheaper is the cost
    f.vendors.set(RACK, [{ npcId: 9, npcName: 'Kendor', zone: 'Stormwind City', places: [], unitPrice: 1500, bundle: 1, limited: false, minStanding: 4 }]);
    expect(setupFor(recipe(57015, 'Tanning Rack', 279941, [[2589, 1]], { learnSkill: 125, teachItemId: RACK }), f))
      .toMatchObject({ cost: 750, where: 'Blueprint: Tanning Rack: 7s 50c on the Alliance auction house, or 15s from Kendor, Stormwind City' });
  });
  it('trainer rows without a spell id match by name; the rank is the recipe\'s learn skill; Horde only is said plainly', () => {
    const f = inputsOf({ listings: { 111: [] }, items: [] });
    f.trainers.push({ npcId: 1, npcName: 'Horde Guy', faction: 'horde', zone: 'Orgrimmar', x: null, y: null, mapId: null, spellId: null, name: 'Smelt Iron', skill: 'Mining', skillRank: 120, cost: 500 });
    expect(setupFor(recipe(3307, 'Smelt Iron', 3575, [[2772, 1]], { learnSkill: 125, profession: 'Mining', spellId: 3307 }), f))
      .toMatchObject({ rank: 125, cost: 500, where: 'no Alliance trainer on record' });
    expect(setupFor(recipe(3307, 'Smelt Iron', 3575, [[2772, 1]], { learnSkill: 125, profession: 'Mining', spellId: 3307, learnSource: 'trainer_horde_only' }), f))
      .toMatchObject({ where: 'Horde trainers only' });
    f.trainers.push({ npcId: 2, npcName: 'Geofram Bouldertoe', faction: 'alliance', zone: 'Ironforge', x: 1, y: 2, mapId: 1455, spellId: null, name: 'Smelt Iron', skill: 'Mining', skillRank: 120, cost: 500 });
    expect(setupFor(recipe(3307, 'Smelt Iron', 3575, [[2772, 1]], { learnSkill: 125, profession: 'Mining', spellId: 3307 }), f))
      .toMatchObject({ rank: 125, cost: 500, where: 'Geofram Bouldertoe, Ironforge' });
    expect(setupFor(recipe(9, 'Arcane Thing', 3575, [[2772, 1]], { learnSkill: 300, learnSource: 'trainer_horde_only' }), f)).toMatchObject({ where: 'Horde trainers only', rank: 300 });
  });
});

describe('open N of the last 72 hours', () => {
  it('never double counts two runs in one hour and never passes 72 (round 1 L3)', () => {
    const d = db();
    publish(d, 111, 100 * HOUR);
    const key = 'auction_vendor:vendor:2589';
    // a flip open every hour for 100 hours, two runs in each hour
    for (let h = 0; h < 100; h++) for (const m of [0, 30]) d.prepare('INSERT INTO flip_history (at, key, expected_profit, per_item, units) VALUES (?, ?, 1, 1, 1)').run(h * HOUR + m * 60_000, key);
    const inputs = buildFlipInputs(d, market(), 100.5 * HOUR);
    expect(inputs.history.openHours.get(key)).toBe(71);
    expect(runFlips(inputs).flips.find(f => f.key === key)!.openHours72).toBe(72);
  });
});
