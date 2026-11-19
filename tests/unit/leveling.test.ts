import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { levelingPlan, crafts } from '../../src/craft/leveling.ts';
import type { PriceBook } from '../../src/analysis/prices.ts';
import { tempDir } from '../helpers.ts';

function setup() {
  const db = openDb(tempDir(), ':memory:');
  db.exec(`INSERT INTO recipes (id, name, profession, crafted_item_id, qty_min, qty_max, learn_skill, yellow, green, grey) VALUES
    (2657, 'Smelt Copper', 'Mining', 2840, 1, 1, 1, 25, 47, 70),
    (1, 'Copper Chain Belt', 'Blacksmithing', 2851, 1, 1, 30, 70, 90, 110),
    (2, 'Silver Skeleton Key', 'Blacksmithing', 15869, 1, 1, 75, 75, 85, 95);
    INSERT INTO recipe_reagents VALUES (2657, 2770, 1), (1, 2840, 6), (2, 2842, 1);`);
  const book: PriceBook = { houseId: 111, faction: 'alliance', houseName: 'Alliance 111',
    floor: new Map([[2770, { floor: 95, units: 9000, at: 0 }], [2840, { floor: 105, units: 9000, at: 0 }], [2842, { floor: 400, units: 50, at: 0 }]]),
    sell: new Map(), binding: new Map(), names: new Map([[2770, 'Copper Ore'], [2840, 'Copper Bar'], [2842, 'Silver Bar']]), vendor: new Map() };
  return { db, book };
}

describe('leveling planner', () => {
  it('estimates crafts from the colors: orange is one craft a point', () => {
    expect(crafts({ yellow: 70, grey: 110 }, 65, 70)).toBe(5);
    expect(crafts({ yellow: 125, grey: 130 }, 125, 129)).toBe(7);
  });
  it('uses ore from the bags to make the bars, then buys only what is still missing', () => {
    const { db, book } = setup();
    db.exec(`INSERT INTO inventory VALUES (2770, 40, 0)`);
    const p = levelingPlan(db, book, 'Blacksmithing', 65, 80);
    const belt = p.steps.find(s => s.recipe === 'Copper Chain Belt')!;
    expect(belt.crafts).toBe(11); // 65 to 70 orange (5), 70 to 75 yellow: 40/40 + 40/39 + 40/38 + 40/37 + 40/36 = 5.3
    const bars = p.needs.find(n => n.itemId === 2840)!;
    expect(bars.need).toBe(66);
    expect(bars.craftedFromBags).toBe(40);
    expect(bars.buy).toBe(26);
    // Buying ore at 95c and smelting beats buying bars at 105c, since Chip has Mining.
    expect(bars.buyCost).toBe(26 * 95);
    expect(bars.source).toMatch(/craft/);
    const silver = p.needs.find(n => n.itemId === 2842)!;
    expect(silver.buy).toBe(6);
  });
  it('flags owned ore worth more sold than smelted', () => {
    const { db, book } = setup();
    book.floor.set(2770, { floor: 200, units: 9000, at: 0 }); // ore sells for far more than a bar costs
    db.exec(`INSERT INTO inventory VALUES (2770, 66, 0)`);
    const p = levelingPlan(db, book, 'Blacksmithing', 65, 75);
    expect(p.sellInstead[0]).toMatchObject({ name: 'Copper Ore', units: 66 });
    expect(p.sellInstead[0]!.saves).toBe(190 * 66 - 105 * 66);
  });
});

describe('crafting from bags through two steps', () => {
  it('Copper Ore and Tin Ore become Bronze Bars: smelt both, then 2 bronze per smelt', () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO recipes (id, name, profession, crafted_item_id, qty_min, qty_max, learn_skill, yellow, green, grey) VALUES
      (2657, 'Smelt Copper', 'Mining', 2840, 1, 1, 1, 25, 47, 70), (3304, 'Smelt Tin', 'Mining', 3576, 1, 1, 1, 50, 62, 75),
      (2659, 'Smelt Bronze', 'Mining', 2841, 2, 2, 1, 65, 90, 115), (5, 'Rough Bronze Leggings', 'Blacksmithing', 2865, 1, 1, 80, 120, 135, 150);
      INSERT INTO recipe_reagents VALUES (2657, 2770, 1), (3304, 2771, 1), (2659, 2840, 1), (2659, 3576, 1), (5, 2841, 6);
      INSERT INTO inventory VALUES (2770, 10, 0), (2771, 10, 0);`);
    const book: PriceBook = { houseId: 111, faction: 'alliance', houseName: 'A', floor: new Map([[2841, { floor: 200, units: 100, at: 0 }]]),
      sell: new Map(), binding: new Map(), names: new Map([[2841, 'Bronze Bar']]), vendor: new Map() };
    const p = levelingPlan(db, book, 'Blacksmithing', 80, 84);
    const bronze = p.needs.find(n => n.itemId === 2841)!;
    expect(bronze.need).toBe(24); // 4 crafts of 6
    expect(bronze.craftedFromBags).toBe(20); // 10 copper + 10 tin -> 10 smelts -> 20 bronze
    expect(bronze.buy).toBe(4);
  });
});
