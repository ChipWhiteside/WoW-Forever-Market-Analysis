import { describe, it, expect } from 'vitest';
import { sellNow } from '../../src/detectors/sellNow.ts';
import { listingPlan } from '../../src/rules/fees.ts';
import { realisticUnits, type DetectorContext, type HouseCtx } from '../../src/detectors/types.ts';
import { openDb } from '../../src/store/db.ts';
import { levelingPlan } from '../../src/craft/leveling.ts';
import { buildServer } from '../../src/server/server.ts';
import type { PriceBook } from '../../src/analysis/prices.ts';
import { tempDir } from '../helpers.ts';

const A: HouseCtx = { id: 111, name: 'Alliance Auction House', faction: 'alliance', cut: 0.05, pinned: true, publishedAt: 1 };
const ctx = (price: number): DetectorContext => ({ houses: [A], listings: new Map([[111, Array.from({ length: 6 }, (_, i) => ({ id: i + 1, itemId: 9, quantity: 1, unitPrice: price, timeLeft: 'LONG' as const }))]]),
  items: new Map([[9, { id: 9, name: 'Thing', sellPrice: 10, binding: null, quality: null }]]), vendors: new Map(), demand: new Map([[111, new Map([[9, { unitsPerDay: 20, hours: 24, snapshots: 24, soldPrice: 200 }]])]]), now: 1 });

describe('review round 2 fixes', () => {
  it('sell now never claims a watchlist price as profit, and never shows a loss', () => {
    const typical = new Map([[111, new Map([[9, { typicalFloor: 100, readings: 30 }]])]]);
    expect(sellNow(ctx(200), typical, [{ itemId: 9, units: 0, unitCost: null, alertAbove: 150 }])).toHaveLength(0);
    expect(sellNow(ctx(200), typical, [{ itemId: 9, units: 5, unitCost: 500, alertAbove: null }])).toHaveLength(0);
    const p = sellNow(ctx(200), typical, [{ itemId: 9, units: 5, unitCost: 100, alertAbove: null }]);
    expect(p[0]!.detail.perItem).toBe(90);
  });
  it('the listing plan never invents sales when the rate is unknown', () => {
    const p = listingPlan('alliance', 15, 20, null, 5);
    expect(p.options.every(o => o.expectedSold === null && o.expectedProfit === null)).toBe(true);
  });
  it('an item measured to sell nothing is worth nothing today', () => {
    expect(realisticUnits(100, 0)).toBe(0);
  });
  it('owned bars used as they are never trigger "sell these instead"', () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO recipes (id, name, profession, crafted_item_id, qty_min, qty_max, learn_skill, yellow, green, grey) VALUES
      (2659, 'Smelt Bronze', 'Mining', 2841, 2, 2, 1, 65, 90, 115), (1, 'Copper Chain Belt', 'Blacksmithing', 2851, 1, 1, 30, 70, 90, 110),
      (5, 'Rough Bronze Leggings', 'Blacksmithing', 2865, 1, 1, 80, 120, 135, 150);
      INSERT INTO recipe_reagents VALUES (2659, 2840, 1), (2659, 3576, 1), (1, 2840, 6), (5, 2841, 6);
      INSERT INTO inventory VALUES (2840, 20, 0);`);
    const book: PriceBook = { houseId: 111, faction: 'alliance', houseName: 'A', floor: new Map([[2840, { floor: 500, units: 9, at: 0 }], [2841, { floor: 100, units: 9, at: 0 }]]),
      sell: new Map(), binding: new Map(), names: new Map(), vendor: new Map() };
    const p = levelingPlan(db, book, 'Blacksmithing', 65, 82);
    expect(p.sellInstead).toHaveLength(0); // bars went into belts directly, nothing was smelted
  });
  it('a plan with an unpriced material says its total is a floor', () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO recipes (id, name, profession, crafted_item_id, qty_min, qty_max, learn_skill, yellow, green, grey) VALUES (1, 'Copper Chain Belt', 'Blacksmithing', 2851, 1, 1, 30, 70, 90, 110);
      INSERT INTO recipe_reagents VALUES (1, 2840, 6);`);
    const book: PriceBook = { houseId: 111, faction: 'alliance', houseName: 'A', floor: new Map(), sell: new Map(), binding: new Map(), names: new Map(), vendor: new Map() };
    const p = levelingPlan(db, book, 'Blacksmithing', 65, 75);
    expect(p.partial).toBe(true);
    expect(p.partialWhy[0]).toMatch(/no price/);
  });
  it('bad numbers are rejected, never treated as delete', async () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO inventory VALUES (2770, 40, 0)`);
    const app = buildServer({ db, engine: null, client: null, port: 0, dataDir: tempDir() });
    const r = await app.inject({ method: 'PUT', url: '/api/inventory', payload: { itemId: 2770, count: 'abc' } });
    expect(r.statusCode).toBe(400);
    expect((db.prepare('SELECT count FROM inventory WHERE item_id = 2770').get() as { count: number }).count).toBe(40);
    const lv = (await app.inject({ url: '/api/leveling?from=abc&to=xyz' })).json();
    expect(Number.isFinite(lv.from) && Number.isFinite(lv.to)).toBe(true);
  });
});
