import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { Crafter, craftBoard, skillUpChance } from '../../src/craft/makeOrBuy.ts';
import type { PriceBook } from '../../src/analysis/prices.ts';
import { tempDir } from '../helpers.ts';

function setup() {
  const db = openDb(tempDir(), ':memory:');
  db.exec(`INSERT INTO recipes (id, name, profession, crafted_item_id, qty_min, qty_max, learn_skill, yellow, green, grey) VALUES
    (2657, 'Smelt Copper', 'Mining', 2840, 1, 1, 1, 25, 47, 70),
    (1631, 'Rough Sharpening Stone', 'Blacksmithing', 2862, 1, 1, 1, 15, 35, 55),
    (9001, 'Copper Chain Belt', 'Blacksmithing', 2851, 1, 1, 35, 75, 87, 100),
    (9002, 'Mystery Thing', 'Blacksmithing', 7777, 1, 1, 1, 10, 20, 30);
    INSERT INTO recipe_reagents VALUES (2657, 2770, 1), (1631, 2835, 1), (9001, 2840, 6), (9002, 9999, 2);`);
  const book: PriceBook = {
    houseId: 110, faction: 'alliance', houseName: 'Alliance 110',
    floor: new Map([[2770, { floor: 150, units: 900, at: 0 }], [2840, { floor: 167, units: 300, at: 0 }], [2835, { floor: 4, units: 9000, at: 0 }],
      [2862, { floor: 30, units: 40, at: 0 }], [2851, { floor: 2000, units: 3, at: 0 }]]),
    sell: new Map([[2770, 5], [2840, 10], [2862, 2], [2851, 160], [7777, 50]]),
    binding: new Map(), names: new Map([[2770, 'Copper Ore'], [2840, 'Copper Bar'], [2835, 'Rough Stone'], [9999, 'Unobtainium']]), vendor: new Map(),
  };
  return { db, book };
}

describe('make or buy (O4)', () => {
  it('Copper Bar: buy the bar at 167 vs smelt ore at 150, smelting wins and is a play on its own', () => {
    const { db, book } = setup();
    const c = new Crafter(db, book);
    expect(c.unitCost(2840, 1)).toMatchObject({ unit: 150, source: 'craft' });
    const row = craftBoard(db, book).find(r => r.recipeId === 2657)!;
    // sale: floor(167*0.95)=158 - deposit max(1, floor(10*0.15)=1)=1 -> 157; cost 150; margin 7
    expect(row.cost).toBe(150);
    expect(row.sale).toBe(157);
    expect(row.margin).toBe(7);
  });
  it('a belt made from bars costs bars at the cheaper of buying and smelting', () => {
    const { db, book } = setup();
    const c = new Crafter(db, book);
    const tree = c.tree(c.recipes.find(r => r.id === 9001)!);
    expect(tree[0]).toMatchObject({ itemId: 2840, quantity: 6, unitCost: 150, source: 'craft' });
    expect(tree[0]!.children![0]).toMatchObject({ itemId: 2770, source: 'auction' });
  });
  it('an ingredient nobody sells is "no source", never a fake zero', () => {
    const { db, book } = setup();
    const row = craftBoard(db, book).find(r => r.recipeId === 9002)!;
    expect(row.cost).toBeNull();
    expect(row.blocked).toMatch(/Unobtainium/);
  });
  it('a bind on pickup product is valued at its vendor price only', () => {
    const { db, book } = setup();
    book.binding.set(2851, 'ON_ACQUIRE');
    const row = craftBoard(db, book).find(r => r.recipeId === 9001)!;
    expect(row.sale).toBe(160);
    expect(row.bop).toBe(true);
  });
  it('skill up odds: certain under yellow, half way between yellow and grey is 50 percent', () => {
    expect(skillUpChance({ yellow: 15, grey: 55 }, 10)).toBe(1);
    expect(skillUpChance({ yellow: 15, grey: 55 }, 35)).toBe(0.5);
    expect(skillUpChance({ yellow: 15, grey: 55 }, 55)).toBe(0);
  });
});
