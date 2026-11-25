/**
 * Round 1 of independent testing (November 24) found the market model trusting too little evidence. One test per
 * finding, each with its numbers stated (docs/flip-plan.md section 6, "Refinements from the first independent test").
 */
import { describe, it, expect } from 'vitest';
import { A, L, many, item, vendor, recipe, sells, inputsOf, evalKey, run, ceruleanAtBens, refExpected, refTail, DYE, DYE_RECIPE } from './flips.fixture.ts';
import { Market } from '../../src/flips/market.ts';
import { SellBook, overnightQueue, lowPerDay } from '../../src/flips/sellBook.ts';
import { soldCurve, priceWar } from '../../src/flips/evaluate.ts';
import { buildFlipInputs, vendorUnitPrice } from '../../src/flips/inputs.ts';
import { poissonLowerBound } from '../../src/flips/poisson.ts';
import { openDb } from '../../src/store/db.ts';
import { MAX_UNITS } from '../../src/rules/flips.ts';
import { tempDir } from '../helpers.ts';

const DYE_KEY = `craft_auction:111:${DYE}:${DYE_RECIPE}`;
const HOUR = 3600_000;

describe('H1: learning, and the low estimate over sale events', () => {
  it('an auction sale under 6 hours of watched sales is held back as learning, with the hours seen', () => {
    const r = run(ceruleanAtBens({ dyeDemand: { hours: 4, hoursWatched: 4 } }));
    expect(r.flips.find(f => f.key === DYE_KEY)).toBeUndefined();
    expect(r.heldBack.find(h => h.key === DYE_KEY)).toMatchObject({ code: 'learning', reason: 'learning: 4 of 6 hours of sales seen' });
    // at 6 hours it ranks
    expect(run(ceruleanAtBens({ dyeDemand: { hours: 6, hoursWatched: 6 } })).flips.find(f => f.key === DYE_KEY)).toBeDefined();
  });
  it('a vendor sale never waits for learning: a vendor buys without limit', () => {
    const r = run({ listings: { 111: [L(2589, 10, 20)] }, items: [item(2589, 'Linen Cloth', 13)] });
    expect(r.flips.find(f => f.family === 'auction_vendor')).toBeDefined();
  });
  it('the ranking uses the event bound: 3 events of 94.67 units over 12 hours', () => {
    const d = sells(568, 7550, { lowPerDay: undefined, saleEvents: 3, unitsPerEvent: 284 / 3, hours: 12, hoursWatched: 12 });
    const q = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: d }))).quote(A, DYE)!;
    expect(q.salesPerDayLow).toBeCloseTo((poissonLowerBound(3) * (284 / 3) / 12) * 24, 9);
    expect(q.salesPerDayLow).toBeCloseTo(154.8, 1);
    expect(q.lowDerived).toBe(true);
    expect(lowPerDay(d).value).toBe(q.salesPerDayLow);
  });
});

describe('H3: risk', () => {
  it('under 72 hours of floors the bad case assumes a 25% drop unless the low seen is lower', () => {
    // 24 hours of floors, a 3 day low of 70s: the 25% drop to 56s 25c is lower, so it is used (net floor(5625 x 0.95) = 5343)
    const { e } = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { hours: 24, hoursWatched: 24 } })), DYE_KEY);
    const S1 = refTail(20, 1);
    expect(e.at(1).risk.badCaseLoss).toBe(Math.round(5020 - (S1 / 2 * 5343 + (1 - S1 / 2) * (75 - 360))));
    expect(e.at(1).risk.drivers).toContain('under 3 days of prices seen, a 25% drop assumed for the bad case');
    // a low seen under the 25% drop is used: 40s nets 3800
    const lower = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { hours: 24, hoursWatched: 24, low3d: 4000 } })), DYE_KEY).e;
    expect(lower.at(1).risk.badCaseLoss).toBe(Math.round(5020 - (S1 / 2 * 3800 + (1 - S1 / 2) * (75 - 360))));
    // 72 hours covered: the low seen is used even when higher than the 25% drop (70s nets 6650)
    const full = evalKey(inputsOf(ceruleanAtBens()), DYE_KEY).e;
    expect(full.at(1).risk.badCaseLoss).toBe(Math.round(5020 - (S1 / 2 * 6650 + (1 - S1 / 2) * (75 - 360))));
  });
  it('the level: high past the expected profit, medium past half of it, low otherwise, at every quantity', () => {
    const { e } = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { low3d: 7200 } })), DYE_KEY);
    const seen = new Set<string>();
    for (let n = 1; n <= 20; n++) {
      const o = e.at(n);
      const want = o.risk.badCaseLoss > o.expectedProfit ? 'high' : o.risk.badCaseLoss > o.expectedProfit / 2 ? 'medium' : 'low';
      expect(o.risk.level).toBe(want);
      seen.add(o.risk.level);
    }
    expect(seen.has('high')).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
  });
  it('a price war is named: the floor fell over 10% this hour, or more new units than sales an hour', () => {
    const fell = run(ceruleanAtBens({ dyeDemand: { floorChange1h: -0.12, newLastHour: 30 } })).flips.find(f => f.key === DYE_KEY)!;
    expect(fell.best.risk.drivers).toContain('price war: floor fell 12% this hour, 30 new listings an hour');
    // 96 new a day (4 an hour) against 60 sold a day (2.5 an hour)
    const flood = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { newPerDay: 96 } })), DYE_KEY).e;
    expect(flood.at(1).risk.drivers).toContain('price war: 4 new listings an hour, more than the 2.5 that sell');
    // a quiet hour is no war
    expect(priceWar({ ...fell.sellQuote, floorChange1h: -0.05, newPerHour: 0.5 })).toBeNull();
  });
  it('big deposits: the best amount stops well before what the queue could take, and half sales lose (the Truesilver case)', () => {
    // Ore at 1g, the bar posted near 1g 40c, with a 5s vendor price: a 24 hour deposit of floor(500 x 0.2 x 24) = 24s a bar.
    const BAR = 6037, ORE = 7911;
    const r = run({ listings: { 111: [L(ORE, 10000, 400), ...many(BAR, 14000, 6, 20)] }, items: [item(ORE, 'Truesilver Ore', 100), item(BAR, 'Truesilver Bar', 500)],
      recipes: [recipe(10098, 'Smelt Truesilver', BAR, [[ORE, 1]], { profession: 'Mining' })],
      demand: { 111: { [BAR]: sells(480, 14000, { lowPerDay: 400, newPerDay: 0 }) } } });
    const f = r.flips.find(x => x.itemId === BAR && x.family === 'craft_auction')!;
    const most = f.options.find(o => o.label === 'most')!;
    // 200 sale events expected overnight; the best stops where a unit's chance no longer covers its 24s deposit risk
    expect(f.best.units).toBeLessThan(most.units);
    expect(f.best.expectedProfit).toBeGreaterThan(most.expectedProfit);
    expect(f.best.risk.deposits).toBe(f.best.units * 2400);
    expect(f.best.risk.atStake).toBe(f.best.cost + f.best.units * 2400);
    expect(most.risk.halfSalesProfit!).toBeLessThan(0);
  });
});

describe('H4: the chance each unit sells falls smoothly', () => {
  it('unit k sells with P(enough events to reach k), events carrying their mean units', () => {
    const q = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { unitsPerEvent: 5 } }))).quote(A, DYE)!;
    const queue = overnightQueue({ ...q, unitsPerEvent: 5 }, 10);
    // (60 - 12) x 10/24 = 20 units overnight, 4 events of 5
    expect(queue.meanEvents).toBeCloseTo(4, 9);
    for (const pos of [1, 5, 6, 10, 11, 20, 21, 30]) expect(queue.at(pos)).toBeCloseTo(refTail(4, Math.ceil(pos / 5)), 12);
    // smooth: never a cliff from 1 to 0, and each next unit is less likely
    const { e, c } = evalKey(inputsOf(ceruleanAtBens()), DYE_KEY);
    const curve = soldCurve(c.quote, overnightQueue(c.quote, 10), 0, 40);
    let last = 1;
    for (let n = 1; n <= 40; n++) {
      const p = curve.soldAt(n) - curve.soldAt(n - 1);
      expect(p).toBeLessThanOrEqual(last + 1e-12);
      // chances under SELL_CHANCE.negligible (0.1%) are not walked
      if (refTail(20, n) >= 0.001) expect(p).toBeCloseTo(refTail(20, n), 12);
      else expect(p).toBeLessThan(0.001);
      last = p;
    }
    // no cliff: the 20th unit (the old flat capacity) still sells more often than not, the 25th sometimes
    expect(curve.soldAt(20) - curve.soldAt(19)).toBeGreaterThan(0.5);
    expect(curve.soldAt(25) - curve.soldAt(24)).toBeGreaterThan(0.1);
    expect(e.at(16).expectedProfit).toBe(Math.round(refExpected({ mu: 20, ahead: 0, net: 7077, salvage: 75, deposit: 360, cost: 90280, n: 16 })));
  });
  it('new posts competing ahead come off the mean, never under 0', () => {
    const q = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { newPerDay: 200 } }))).quote(A, DYE)!;
    expect(overnightQueue(q, 10).meanEvents).toBe(0);
    expect(overnightQueue(q, 10).at(1)).toBe(0);
  });
});

describe('M2: the lower bound never depends on evaluation order', () => {
  // S is listed. R is made from S, C4 from R, C3 from C4, C2 from C3, C1 from C2. P1 needs C1 (too deep to make),
  // Q needs C3 (three crafts down to S, within the depth limit). Asking about C1 first used to memoize C4 as
  // impossible (cut at the depth limit), and then Q read "no way to get" C3.
  const S = 900001, R = 900002, C4 = 900003, C3 = 900004, C2 = 900005, C1 = 900006, P1 = 900007, Q = 900008;
  const chain = [recipe(1, 'R', R, [[S, 1]]), recipe(2, 'C4', C4, [[R, 1]]), recipe(3, 'C3', C3, [[C4, 1]]), recipe(4, 'C2', C2, [[C3, 1]]), recipe(5, 'C1', C1, [[C2, 1]])];
  const P1r = recipe(6, 'P1', P1, [[C1, 1]]), Qr = recipe(7, 'Q', Q, [[C3, 1]]);
  const fixture = (recipes: ReturnType<typeof recipe>[]) => ({ listings: { 111: [L(S, 10, 100)] },
    items: [S, R, C4, C3, C2, C1].map(id => item(id, `I${id}`, 1)).concat([item(P1, 'P1', 5000), item(Q, 'Q', 5000)]), recipes });
  it('recipe Q is listed whichever recipe is looked at first', () => {
    for (const order of [[P1r, Qr, ...chain], [Qr, P1r, ...chain], [...chain, P1r, Qr]]) {
      const r = run(fixture(order));
      const q = r.flips.find(f => f.itemId === Q);
      expect(q, `order ${order.map(x => x.name).join(',')}`).toBeDefined();
      expect(r.heldBack.filter(h => h.itemId === Q && h.code === 'reagent with no source')).toEqual([]);
      // P1 really is too deep, in every order
      expect(r.heldBack.find(h => h.itemId === P1)?.code).toBe('reagent with no source');
    }
  });
  it('a bound worked out under a depth cut is never reused elsewhere', () => {
    const inputs = inputsOf(fixture([P1r, Qr, ...chain]));
    const m1 = new Market(inputs, inputs.recipes);
    expect(m1.lowerBound(C1)).toBe(Infinity);
    const m2 = new Market(inputs, inputs.recipes);
    expect(m1.lowerBound(C3)).toBe(m2.lowerBound(C3));
    expect(m1.lowerBound(C3)).toBe(10);
  });
});

describe('M3: cheap listing, the cheap units left unbought stay ahead', () => {
  it('buying 5 of 10 cheap units leaves 5 in front of his own', () => {
    const ORE = 2770;
    const fx = { listings: { 111: [L(ORE, 60, 10), ...many(ORE, 100, 6, 10)] }, items: [item(ORE, 'Copper Ore', 5)],
      typical: { 111: { [ORE]: 100 } }, demand: { 111: { [ORE]: sells(24, 100, { lowPerDay: 24, newPerDay: 0 }) } } };
    const { e, c } = evalKey(inputsOf(fx), `cheap_listing:111:${ORE}`);
    expect(c.quote.ahead).toBe(10);
    expect(c.quote.ownAhead).toBe(10);
    // 24 a day: 10 events overnight. 5 bought: positions 6 to 10. 10 bought: positions 1 to 10.
    const sum = (a: number, b: number) => { let s = 0; for (let p = a; p <= b; p++) s += refTail(10, p); return s; };
    expect(e.at(5).expectedSold).toBe(Math.round(sum(6, 10) * 10) / 10);
    expect(e.at(10).expectedSold).toBe(Math.round(sum(1, 10) * 10) / 10);
    const curve = soldCurve(c.quote, overnightQueue(c.quote, 10), 0, 10);
    expect(curve.soldAt(5)).toBeCloseTo(sum(6, 10), 12);
  });
});

describe('L1: vendor unit price from the price per purchase', () => {
  it('Rough Arrow 10c for 200 is 0.05c each; Shiny Red Apple 25c for 5 is 5c (Friendly price, the most Chip pays)', () => {
    expect(vendorUnitPrice('{"5":10}', 200, 1)).toBe(0.05);
    expect(vendorUnitPrice('{"5":25,"6":23}', 5, 6)).toBe(5);
    expect(vendorUnitPrice(null, 5, 6)).toBe(6);
    const d = openDb(tempDir(), ':memory:');
    d.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES (111, 'Alliance Auction House', 'alliance', 0.05, 1, 0);
      INSERT INTO items (id, name, quality, sell_price, status, fetched_at) VALUES (2512, 'Rough Arrow', 'COMMON', 0, 200, 0), (4536, 'Shiny Red Apple', 'COMMON', 1, 200, 0);
      INSERT INTO vendor_items (npc_id, npc_name, faction, zone, item_id, price, price_by_standing, units_per_purchase, limited, standing_required) VALUES
      (151, 'Brog Hamfist', 'alliance', 'Elwynn Forest', 2512, 1, '{"5":10}', 200, 0, '5'), (66, 'Tharynn Bouden', 'alliance', 'Elwynn Forest', 4536, 6, '{"5":25,"6":23}', 5, 0, '5');`);
    const inputs = buildFlipInputs(d, new Map([[111, [L(2589, 10, 1)]]]), HOUR);
    expect(inputs.vendors.get(2512)![0]).toMatchObject({ unitPrice: 0.05, bundle: 200 });
    expect(inputs.vendors.get(4536)![0]).toMatchObject({ unitPrice: 5, bundle: 5 });
  });
});

describe('L6: the most row never passes MAX_UNITS', () => {
  it('a craft yielding 3 that pays without limit stops at MAX_UNITS', () => {
    const ORE = 2770, BAR = 2840;
    const r = run({ listings: { 111: [L(ORE, 1, 4000)] }, items: [item(ORE, 'Copper Ore', 1), item(BAR, 'Copper Bar', 10)],
      recipes: [recipe(2657, 'Smelt Copper', BAR, [[ORE, 1]], { profession: 'Mining', qtyMin: 3, qtyMax: 3, castMs: 1 })] });
    const f = r.flips.find(x => x.family === 'craft_vendor')!;
    for (const o of f.options) expect(o.units).toBeLessThanOrEqual(MAX_UNITS);
    expect(f.options.find(o => o.label === 'most')!.units).toBe(MAX_UNITS);
  });
});

describe('sale events and new posts from the stored hourly counts', () => {
  it('events are the vanished listings scaled by the share of vanished units judged sold; new posts near the floor', () => {
    const d = openDb(tempDir(), ':memory:');
    d.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES (111, 'Alliance Auction House', 'alliance', 0.05, 1, 0);
      INSERT INTO items (id, name, quality, sell_price, status, fetched_at) VALUES (12359, 'Thorium Bar', 'COMMON', 150, 200, 0);`);
    const snap = (at: number, diff: number | null) => Number(d.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, diff_hours)
      VALUES (111, ?, ?, ?, ?, 0, 0, 0, ?)`).run('commodities', `c${at}`, at, at, diff).lastInsertRowid);
    const stat = d.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder,
      gone_listings, gone_units, gone_units_expiring, gone_units_near_floor, new_units, gone_units_expiring_near_floor, sold_value, new_near_floor) VALUES (?, 111, 12359, ?, ?, 1, 1, 1, 1, '[]', ?, ?, 0, ?, ?, ?, ?, ?)`);
    // The real record of November 24, 06:25 (Thorium Bar on 111): 10 listings and 238 units gone, all near the floor,
    // 210 of them expiring, so 28 sold; 913 new units. Then the floor fell from 2180 to 1900 with 40 new near it.
    snap(0, null); d.prepare('INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes) VALUES (111, \'auctions\', \'a0\', 0, 0, 0, 0, 0)').run();
    let t = 0;
    for (let h = 1; h <= 7; h++) {
      t = h * HOUR;
      d.prepare('INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, diff_hours) VALUES (111, \'auctions\', ?, ?, ?, 0, 0, 0, 1)').run(`a${t}`, t, t);
      const id = snap(t, 1);
      if (h < 7) stat.run(id, t, 2180, 10, 238, 238, 913, 210, 61096, null);
      else stat.run(id, t, 1900, 10, 238, 238, 913, 210, 61096, 40);
    }
    const inputs = buildFlipInputs(d, new Map([[111, [L(12359, 1900, 10)]]]), t);
    const dm = inputs.demand.get(111)!.get(12359)!;
    // 7 hours: 7 x 28 = 196 units sold, 7 x 10 x 28/238 = 8.24 events of 23.8 units
    expect(dm.saleEvents).toBeCloseTo(7 * 10 * 28 / 238, 9);
    expect(dm.unitsPerEvent).toBeCloseTo(238 / 10, 9);
    // new posts: new_near_floor where measured (40), else new_units (913): (6 x 913 + 40) / 7 hours x 24
    expect(dm.newPerDay).toBeCloseTo(((6 * 913 + 40) / 7) * 24, 6);
    expect(dm.floorChange1h).toBeCloseTo((1900 - 2180) / 2180, 9);
    expect(dm.newLastHour).toBe(40);
    // floors from 1 to 7 hours: 6 hours behind the 3 day low, so the bad case still assumes the 25% drop
    expect(inputs.low3dHours!.get(111)!.get(12359)).toBe(6);
    expect(inputs.low3d.get(111)!.get(12359)).toBe(1900);
    // a floor recorded before the 72 hour window proves full coverage, and the low is still from inside the window
    d.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder) VALUES (9999, 111, 12359, ?, 100, 1, 1, 1, 1, '[]')`).run(t - 80 * HOUR);
    const later = buildFlipInputs(d, new Map([[111, [L(12359, 1900, 10)]]]), t);
    expect(later.low3dHours!.get(111)!.get(12359)).toBe(80);
    expect(later.low3d.get(111)!.get(12359)).toBe(1900);
  });
});
