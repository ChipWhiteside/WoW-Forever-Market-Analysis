/**
 * Whole system review round 2 (November 26), Agent F fixes. Backtest proof: scratchpad findings-system-r2-fix-F.txt.
 *   A: a slow undercutter (Hot Spices) read as no competition; B: competition read over 24 hours, sales over 72;
 *   thin evidence (Timbermaw Brawlers on 2 listings); C: a recipe nobody knows how to learn ranked by profit alone.
 */
import { describe, it, expect } from 'vitest';
import { A, L, item, vendor, sells, inputsOf, run, ceruleanAtBens, DYE, DYE_RECIPE } from './flips.fixture.ts';
import { SellBook } from '../../src/flips/sellBook.ts';
import { priceWar } from '../../src/flips/evaluate.ts';
import { enrichDemand, type FlipDemand } from '../../src/flips/inputs.ts';
import { HORDE_ONLY_DRIVER, RANKED_LOWER, COMPETITION_LEARNING } from '../../src/flips/run.ts';
import { openDb } from '../../src/store/db.ts';
import { tempDir } from '../helpers.ts';

const DYE_KEY = `craft_auction:111:${DYE}:${DYE_RECIPE}`;
const HOUR = 3600_000;
const SPICES = 3713;

describe('A: floor drift', () => {
  it('is the least squares slope of the hourly floors over 72 hours, with the fitted fall across the window', () => {
    const d = openDb(tempDir());
    const ins = d.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder)
      VALUES (?, 111, ?, ?, ?, 1, 1, 1, 1, '[]')`);
    const now = 100 * HOUR;
    // item 1 falls 2c an hour from 200c over 10 hours; item 2 is flat; item 3 has only 5 readings
    for (let h = 0; h <= 10; h++) {
      ins.run(h + 1, 1, now - (10 - h) * HOUR, 200 - 2 * h);
      ins.run(h + 1, 2, now - (10 - h) * HOUR, 150);
      if (h < 5) ins.run(h + 1, 3, now - (10 - h) * HOUR, 300 - 20 * h);
    }
    // a reading older than the window is ignored
    ins.run(99, 1, now - 80 * HOUR, 10_000);
    const dem = new Map<number, FlipDemand>([1, 2, 3].map(i => [i, sells(10, 100)]));
    enrichDemand(d, 111, now, dem);
    expect(dem.get(1)!.floorSlope).toBeCloseTo(-2, 9);
    expect(dem.get(1)!.floorFall).toBeCloseTo(20 / 200, 9);
    expect(dem.get(1)!.floorSpanHours).toBeCloseTo(10, 9);
    expect(dem.get(2)!.floorSlope).toBeCloseTo(0, 9);
    expect(dem.get(2)!.floorFall).toBeCloseTo(0, 9);
    expect(dem.get(3)!.floorSlope).toBeUndefined();
  });

  it('a falling floor lowers the claim by the slope times the horizon, and says so', () => {
    const flat = new SellBook(inputsOf(ceruleanAtBens())).quote(A, DYE)!;
    const falling = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { floorSlope: -5, floorFall: 0.04, floorSpanHours: 30 } }))).quote(A, DYE)!;
    expect(falling.driftDrop).toBe(50); // 5c an hour over the 10 hour night
    expect(falling.claimPrice).toBe(flat.claimPrice - 50);
    expect(falling.note).toMatch(/the floor has been falling about 5c an hour, so the price used is 50c lower for the night/);
    // a rising floor never raises it
    const rising = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { floorSlope: 5, floorFall: -0.04, floorSpanHours: 30 } }))).quote(A, DYE)!;
    expect(rising.claimPrice).toBe(flat.claimPrice);
    expect(rising.driftDrop).toBe(0);
  });

  it('a fitted fall of 10 percent across the window is a price war, even when no single hour fell 10 percent', () => {
    const base = new SellBook(inputsOf(ceruleanAtBens())).quote(A, DYE)!;
    expect(priceWar({ ...base, floorChange1h: -0.02, floorFall: 0.09, floorSpanHours: 30 })).toBeNull();
    expect(priceWar({ ...base, floorChange1h: -0.02, floorFall: 0.1, floorSpanHours: 30 })).toMatch(/^price war: floor fell 10% over the last 30 hours/);
    // the hourly check still wins when it fires
    expect(priceWar({ ...base, floorChange1h: -0.12, floorFall: 0.2, floorSpanHours: 30 })).toMatch(/this hour/);
  });

  it('while the floor falls, posts under the floor of their hour count as competition whatever price Chip takes', () => {
    const fx = ceruleanAtBens({ dyeDemand: { floorSlope: -5, floorFall: 0.04, floorSpanHours: 30 } });
    const inputs = inputsOf(fx);
    // 24 hours watched: 24 units at 90s, far above his post, but 48 of them were posted under the floor of their hour
    inputs.newPosts = new Map([[111, { hours: 24, byItem: new Map([[DYE, [[9000, 24]] as Array<[number, number]>]]), underFloor: new Map([[DYE, 48]]) }]]);
    expect(new SellBook(inputs).quote(A, DYE)!.newPerHour).toBe(2);
    // a flat floor uses only the posts at or under 1.05 times the post price
    const flat = inputsOf(ceruleanAtBens());
    flat.newPosts = inputs.newPosts;
    expect(new SellBook(flat).quote(A, DYE)!.newPerHour).toBe(0);
  });
});

describe('B: competition not measured is learning, never zero', () => {
  it('raw publishes under 6 hours hold the auction flip back', () => {
    const inputs = inputsOf(ceruleanAtBens());
    inputs.newPosts = new Map([[111, { hours: 4, byItem: new Map() }]]);
    const r = run(inputs);
    expect(r.flips.find(f => f.key === DYE_KEY)).toBeUndefined();
    expect(r.heldBack.find(h => h.key === DYE_KEY)).toMatchObject({ reason: COMPETITION_LEARNING, code: 'learning' });
  });
});

describe('thin evidence: at least 3 sale events', () => {
  it('2 sale events hold an auction flip back; 3 rank it', () => {
    const two = run(ceruleanAtBens({ dyeDemand: { saleEvents: 2 } }));
    expect(two.flips.find(f => f.key === DYE_KEY)).toBeUndefined();
    expect(two.heldBack.find(h => h.key === DYE_KEY)).toMatchObject({ reason: 'learning: 2 sales seen, at least 3 needed', code: 'few sales seen' });
    expect(run(ceruleanAtBens({ dyeDemand: { saleEvents: 3 } })).flips.find(f => f.key === DYE_KEY)).toBeDefined();
  });
});

describe('C: a recipe nobody knows how to learn ranks after every known one', () => {
  const market = (learnSource: string | null) => {
    const fx = ceruleanAtBens({ extra: {
      listings: { 111: [L(SPICES, 300, 10), L(SPICES, 301, 10), L(SPICES, 310, 10)] },
      items: [item(SPICES, 'Soothing Spices', 40)],
      vendors: { [SPICES]: [vendor('Kendor Kabonka', 160)] },
      demand: { 111: { [SPICES]: sells(20, 300, { lowPerDay: 20, newPerDay: 4, low3d: 290 }) } },
    } });
    fx.recipes = fx.recipes!.map(r => ({ ...r, learnSource }));
    return run(fx);
  };
  it('the unknown dye earns more yet ranks after the spices, and the card says why', () => {
    const r = market(null);
    const dye = r.flips.find(f => f.key === DYE_KEY)!, spices = r.flips.find(f => f.itemId === SPICES)!;
    expect(dye.best.expectedProfit).toBeGreaterThan(spices.best.expectedProfit);
    expect(spices.rank!).toBeLessThan(dye.rank!);
    expect(dye.notes).toContain(RANKED_LOWER);
    expect(RANKED_LOWER).toBe('ranked lower: how to learn it is not known yet');
  });
  it('requirements Chip can train never lower a flip: Horde only and trainer recipes rank on profit', () => {
    for (const src of ['trainer_alliance', 'trainer_horde_only', 'auto']) {
      const r = market(src);
      expect(r.flips[0]!.key).toBe(DYE_KEY);
      expect(r.flips[0]!.notes).not.toContain(RANKED_LOWER);
    }
  });
});

describe('card text', () => {
  it('no ledger codes in what Chip reads', () => {
    expect(HORDE_ONLY_DRIVER).not.toMatch(/\([A-Z]\d+\)/);
  });
});
