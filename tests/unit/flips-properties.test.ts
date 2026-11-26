import { describe, it, expect } from 'vitest';
import { A, B, L, many, item, vendor, recipe, sells, inputsOf, evalKey, run, ceruleanAtBens, refExpected, refRevenue, refTail, LICHEN, VIAL, DYE, DYE_RECIPE } from './flips.fixture.ts';
import { Market } from '../../src/flips/market.ts';
import { SellBook } from '../../src/flips/sellBook.ts';
import type { Listing } from '../../src/analysis/aggregate.ts';

const DYE_KEY = `craft_auction:111:${DYE}:${DYE_RECIPE}`;
const bestOf = (r: ReturnType<typeof run>, key: string) => r.flips.find(f => f.key === key)?.best.expectedProfit ?? 0;

describe('cost book: depth', () => {
  it('buying 200 walks the ladder: 50 at 10c, 100 at 12c, then 50 of the 15c listing', () => {
    const ORE = 2770;
    const inputs = inputsOf({ listings: { 111: [L(ORE, 15, 100), L(ORE, 10, 50), L(ORE, 12, 100)] }, items: [item(ORE, 'Copper Ore', 5)] });
    const m = new Market(inputs, []);
    const curve = m.curve(ORE, 200);
    // 50 x 10 + 100 x 12 + 50 x 15 = 500 + 1200 + 750 = 2450
    expect(curve.steps.map(s => [s.unitCost, s.units])).toEqual([[10, 50], [12, 100], [15, 50]]);
    expect(curve.steps.reduce((a, s) => a + s.unitCost * s.units, 0)).toBe(2450);
    // curve() leaves the market as it was
    expect(m.peekAuction(111, ORE)!.price).toBe(10);
  });
  it('within one recipe tree a shared sub reagent never gets the same cheap listings twice', () => {
    const COPPER = 2840, TIN = 3576, BRONZE = 2841, THING = 2851;
    const inputs = inputsOf({ listings: { 111: [L(COPPER, 10, 2), L(COPPER, 50, 100), L(TIN, 20, 100), L(BRONZE, 200, 100)] },
      items: [item(COPPER, 'Copper Bar', 10), item(TIN, 'Tin Bar', 10), item(BRONZE, 'Bronze Bar', 50), item(THING, 'Copper Chain Belt', 100)],
      recipes: [recipe(2659, 'Smelt Bronze', BRONZE, [[COPPER, 1], [TIN, 1]], { profession: 'Mining' }), recipe(2661, 'Copper Chain Belt', THING, [[COPPER, 2], [BRONZE, 1]])] });
    const m = new Market(inputs, inputs.recipes);
    // 2 Copper Bars at 10c, then the Bronze Bar is smelted (copper now at 50c + tin 20c = 70c, under the 2s listing): 10 + 10 + 70 = 90
    expect(m.craftOnce(inputs.recipes[1]!, new Set(), 1, null)).toBe(90);
  });
  it('a recipe cycle (A makes B, B makes A) is guarded and the run completes', () => {
    const X = 10938, Y = 10939;
    const r = run({ listings: { 111: [L(X, 100, 50), L(Y, 300, 50), ...many(Y, 300, 6, 5)] }, items: [item(X, 'Lesser Magic Essence', 10), item(Y, 'Greater Magic Essence', 30)],
      recipes: [recipe(13361, 'Greater from Lesser', Y, [[X, 3]], { kind: 'conversion' }), recipe(13362, 'Lesser from Greater', X, [[Y, 1]], { kind: 'conversion', qtyMin: 3, qtyMax: 3 })],
      demand: { 111: { [Y]: sells(48, 400, { lowPerDay: 48, newPerDay: 0 }) } } });
    expect(r.report.complete).toBe(true);
    for (const f of r.flips) expect(Number.isFinite(f.best.cost)).toBe(true);
  });
  it('a limited stock vendor is capped, and the bundle size comes from the vendor', () => {
    const SPICE = 2678;
    const inputs = inputsOf({ listings: {}, items: [item(SPICE, 'Mild Spices', 1)], vendors: { [SPICE]: [vendor('Limited Larry', 10, 5, true)] } });
    const m = new Market(inputs, []);
    const curve = m.curve(SPICE, 20);
    expect(curve.steps).toEqual([expect.objectContaining({ source: 'vendor', unitCost: 10, units: 5 })]);
  });
});

describe('properties', () => {
  it('raising a reagent price never raises profit', () => {
    let last = Infinity;
    for (const k of [0, 50, 100, 300, 600, 1000, 3000]) {
      const lichen = [L(LICHEN, 2500 + k, 2), L(LICHEN, 2700 + k, 4), L(LICHEN, 2800 + k, 10), L(LICHEN, 2900 + k, 20), L(LICHEN, 3000 + k, 40)];
      const p = bestOf(run(ceruleanAtBens({ lichen })), DYE_KEY);
      expect(p).toBeLessThanOrEqual(last);
      last = p;
    }
    expect(last).toBe(0);
  });
  it('a listing above the floor never raises the claimed price', () => {
    const base = new SellBook(inputsOf(ceruleanAtBens())).quote(A, DYE)!.claimPrice;
    for (const extra of [L(DYE, 7500, 1), L(DYE, 7600, 50), L(DYE, 9000, 3), L(DYE, 500_000, 1)]) {
      const f = ceruleanAtBens();
      f.listings[111]!.push(extra);
      expect(new SellBook(inputsOf(f)).quote(A, DYE)!.claimPrice).toBeLessThanOrEqual(base);
    }
  });
  it('splitting a reagent listing changes nothing', () => {
    const whole = run(ceruleanAtBens()).flips.find(f => f.key === DYE_KEY)!;
    const split = run(ceruleanAtBens({ lichen: [L(LICHEN, 2500, 1), L(LICHEN, 2500, 1), L(LICHEN, 2700, 4), L(LICHEN, 2800, 3), L(LICHEN, 2800, 7), L(LICHEN, 2900, 20), L(LICHEN, 3000, 20), L(LICHEN, 3000, 20)] }))
      .flips.find(f => f.key === DYE_KEY)!;
    expect(split.options).toEqual(whole.options);
    expect(split.perItem).toBe(whole.perItem);
  });
  it('the shared pass never hands out more units than are listed', () => {
    const TONIC = 249500;
    const f = ceruleanAtBens({ extra: {
      listings: { 111: [L(TONIC, 12000, 5), L(TONIC, 12001, 5), L(TONIC, 12050, 5), L(TONIC, 12100, 5)] },
      items: [item(TONIC, 'Frilled Tonic', 90)],
      recipes: [recipe(54460, 'Frilled Tonic', TONIC, [[LICHEN, 3]])],
      demand: { 111: { [TONIC]: sells(60, 12000, { lowPerDay: 60, newPerDay: 12 }) } },
    } });
    const r = run(f);
    const users = r.flips.filter(x => x.buy.some(l => l.itemId === LICHEN));
    expect(users.length).toBe(2);
    // standalone they want 40 + 60 = 100 lichen; 76 are listed
    expect(users.reduce((a, x) => a + x.buy.find(l => l.itemId === LICHEN)!.units, 0)).toBeGreaterThan(76);
    const handed = users.reduce((a, x) => a + (x.sharedUse?.find(u => u.itemId === LICHEN)?.units ?? 0), 0);
    expect(handed).toBeLessThanOrEqual(76);
    expect(users[1]!.shares).toContain(users[0]!.key);
    expect(users[1]!.afterShared!.units).toBeLessThan(users[1]!.best.units);
    // and sharing never makes a flip look better than it does alone
    for (const x of r.flips) {
      expect(x.afterShared!.units).toBeLessThanOrEqual(x.best.units);
      expect(x.afterShared!.expectedProfit).toBeLessThanOrEqual(x.best.expectedProfit);
    }
  });
  it('risk rises with quantity', () => {
    const { e } = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { low3d: 5000 } })), DYE_KEY);
    let last = -1;
    for (let n = 1; n <= 20; n++) {
      const loss = e.at(n).risk.badCaseLoss;
      expect(loss).toBeGreaterThanOrEqual(last);
      last = loss;
    }
    // Bad case (round 1 H3, carryover round 4): the 3 day low of 50s nets floor(5000 x 0.95) = 4750; half of tonight's
    //   expected sales and half of tomorrow's happen (events over tonight 20, over both days 68); unsold units are relisted
    //   for one more 360c deposit when that beats the 75c vendor price. Recomputed independently (refRevenue).
    const bad = (n: number, cost: number, mu: number, mu2?: number) =>
      Math.max(0, Math.round(cost - refRevenue({ mu, mu2, ahead: 0, net: 4750, salvage: 75, deposit: 360, n, shortTonight: 0.5, shortTomorrow: 0.5 })));
    expect(Math.abs(e.at(20).risk.badCaseLoss - bad(20, 113880, 20, 68))).toBeLessThanOrEqual(1);
    expect(Math.abs(e.at(1).risk.badCaseLoss - bad(1, 5020, 20, 68))).toBeLessThanOrEqual(1);
    // the same with half the sales at the claimed price, the "at half sales" number on the card
    expect(Math.abs(e.at(1).risk.halfSalesProfit! - (refRevenue({ mu: 20, mu2: 68, ahead: 0, net: 7077, salvage: 75, deposit: 360, n: 1, shortTonight: 0.5, shortTomorrow: 0.5 }) - 5020))).toBeLessThanOrEqual(1);
    // No proven demand (low estimate 0.8 a day, 12 a day middle, none new: 5 sale events overnight): nothing carries over,
    //   unsold units are worth only their 75c vendor price, each unit past the queue adds its cost and lost deposit.
    const thin = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { low3d: 5000, unitsPerDay: 12, lowPerDay: 0.8, newPerDay: 0 } })), DYE_KEY).e;
    let prev = -1;
    for (let n = 1; n <= 10; n++) { const loss = thin.at(n).risk.badCaseLoss; expect(loss).toBeGreaterThanOrEqual(prev); prev = loss; }
    expect(thin.at(10).risk.level).toBe('high');
    expect(thin.at(10).expectedProfit).toBe(Math.round(refExpected({ mu: 5, ahead: 0, net: 7077, salvage: 75, deposit: 360, cost: 55440, n: 10 })));
    expect(thin.at(10).risk.badCaseLoss).toBe(bad(10, 55440, 5));
    expect(thin.at(10).risk.drivers).toContain('more units than sell overnight');
    // The same thin market with proven demand (1.2 a day low): unsold units relist and sell tomorrow (events over both
    //   days 12 x 34/24 = 17), so the loss is smaller
    const proven = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { low3d: 5000, unitsPerDay: 12, lowPerDay: 1.2, newPerDay: 0 } })), DYE_KEY).e;
    expect(Math.abs(proven.at(10).risk.badCaseLoss - bad(10, 55440, 5, 17))).toBeLessThanOrEqual(1);
    expect(proven.at(10).risk.badCaseLoss).toBeLessThan(thin.at(10).risk.badCaseLoss);
  });
  it('gold on hand caps every quantity by the full cost to do it, crafts included', () => {
    const r = run(ceruleanAtBens({ extra: { settings: { goldOnHand: 50000 } } }));
    const f = r.flips.find(x => x.key === DYE_KEY)!;
    // Gold pays for the crafts and the 360c deposit on every dye posted (round 1 H3):
    //   8 crafts: 5004 + 2 x 5404 + 5 x 5604 = 43,820 plus 2 vial bundles 40 = 43,840, and 8 x 360 deposits: 46,720, fits
    //   9 crafts: 49,640 and 9 x 360: 52,880, over 50,000
    expect(f.best.units).toBe(8);
    expect(f.best.cost).toBe(43840);
    expect(f.best.risk.atStake).toBe(46720);
    expect(f.notes).toContain('capped by your gold on hand');
  });
  it('with no new listing count, none are assumed and the card says so; the 25% fallback is gone (round 1 H2)', () => {
    const f = run(ceruleanAtBens({ dyeDemand: { newPerDay: undefined } })).flips.find(x => x.key === DYE_KEY)!;
    expect(f.sellQuote.newOvernight).toBe(0);
    expect(f.sellQuote.newDerived).toBe(true);
    expect(f.notes).toContain('new listings under you are not measured yet for this item; none are assumed');
    expect(f.notes.join(' ')).not.toMatch(/quarter/);
  });
  it('new listings overnight are the measured new units an hour times the horizon (round 1 H2)', () => {
    // 36 new units near the floor a day, 1.5 an hour, over the 10 hour night: 15 ahead of him, and 15 fewer sale events
    const f = run(ceruleanAtBens({ dyeDemand: { newPerDay: 36 } })).flips.find(x => x.key === DYE_KEY)!;
    expect(f.sellQuote.newPerHour).toBeCloseTo(1.5, 9);
    expect(f.sellQuote.newOvernight).toBeCloseTo(15, 9);
    const { e } = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { newPerDay: 36 } })), DYE_KEY);
    // events overnight: (60 - 36) x 10/24 = 10
    expect(e.at(5).expectedSold).toBe(Math.round(10 * [1, 2, 3, 4, 5].reduce((a, k) => a + refTail(10, k), 0)) / 10);
  });
  it('a time rate charges minutes; at the default 0 minutes are shown, never charged', () => {
    const free = run(ceruleanAtBens()).flips.find(x => x.key === DYE_KEY)!;
    const paid = run(ceruleanAtBens({ extra: { settings: { timeRate: 10000 } } })).flips.find(x => x.key === DYE_KEY)!;
    expect(free.best.minutes).toBeGreaterThan(0);
    expect(paid.best.expectedProfit).toBeLessThan(free.best.expectedProfit);
  });
});

describe('Chip\'s houses only', () => {
  it('no house other than Chip\'s ever appears, on either side', () => {
    const CLOTH = 2589;
    const f = ceruleanAtBens({ extra: { houses: [A, B], listings: { 116: [L(CLOTH, 5, 10), ...many(DYE, 7000, 6, 5)] }, items: [item(CLOTH, 'Linen Cloth', 13)] } });
    const inputs = inputsOf(f);
    // A house that is not Chip's, with a juicy listing, is simply not in the inputs.
    (inputs.listings as Map<number, Map<number, Listing[]>>).set(110, new Map([[LICHEN, [L(LICHEN, 1, 1000)]]]));
    const r = run(inputs);
    expect(r.flips.length).toBeGreaterThan(0);
    for (const fl of r.flips) {
      expect([111, 116, null]).toContain(fl.sellHouseId);
      for (const l of fl.buy) if (l.houseId != null) expect([111, 116]).toContain(l.houseId);
    }
    expect(r.flips.some(fl => fl.buy.some(l => l.itemId === LICHEN && l.unitPrice < 100))).toBe(false);
  });
});

describe('vendor sales', () => {
  it('craft to vendor: no cut, no limit, buys reagents only while under the vendor price', () => {
    const ORE = 2770, BAR = 2840;
    const r = run({ listings: { 111: [L(ORE, 5, 30), L(ORE, 8, 30), L(ORE, 20, 100)] }, items: [item(ORE, 'Copper Ore', 2), item(BAR, 'Copper Bar', 10)],
      recipes: [recipe(2657, 'Smelt Copper', BAR, [[ORE, 1]], { profession: 'Mining' })] });
    const f = r.flips.find(x => x.family === 'craft_vendor')!;
    // 30 x (10 - 5) = 150; the 8c ore clears only 2c, under the 5c vendor margin (round 2 M3), and the 20c ore would lose
    expect(f.best.units).toBe(30);
    expect(f.best.expectedProfit).toBe(150);
    expect(f.kind).toBe('craft');
    expect(f.sellHouseId).toBeNull();
  });
});

describe('a vial bundle and a cheaper single', () => {
  it('the vial vendor sells 5 at a time: the cost book never pretends one costs 4c alone', () => {
    const inputs = inputsOf(ceruleanAtBens());
    const m = new Market(inputs, []);
    const c = m.curve(VIAL, 1);
    expect(c.steps[0]).toMatchObject({ source: 'vendor', units: 5, unitCost: 4 });
  });
});
