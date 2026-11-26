import { describe, it, expect } from 'vitest';
import { A, B, L, many, item, vendor, recipe, sells, inputsOf, evalKey, run, ceruleanAtBens, LICHEN, VIAL, DYE, BAUBLES, DYE_RECIPE, type Fixture } from './flips.fixture.ts';
import { lowPerDay, typicalUndercut } from '../../src/flips/sellBook.ts';
import { dyeCost, refBest, refBestSafe, refExpected, refRevenue, refTail } from './flips.fixture.ts';
import { poissonLowerBound, poissonTail } from '../../src/flips/poisson.ts';

const DYE_KEY = `craft_auction:111:${DYE}:${DYE_RECIPE}`;
const SPICES = 3713, CLOTH = 2589, BANDAGE = 1251;

/** Cerulean Dye plus two weaker flips: Soothing Spices vendor to auction, and a Linen Bandage craft. */
function bensMarket(): Fixture {
  return ceruleanAtBens({ extra: {
    listings: { 111: [L(SPICES, 300, 10), L(SPICES, 301, 10), L(SPICES, 310, 10), L(CLOTH, 10, 50), L(BANDAGE, 40, 10), L(BANDAGE, 41, 10), L(BANDAGE, 45, 10)] },
    items: [item(SPICES, 'Soothing Spices', 40), item(CLOTH, 'Linen Cloth', 13), item(BANDAGE, 'Linen Bandage', 10)],
    vendors: { [SPICES]: [vendor('Kendor Kabonka', 160)] },
    recipes: [recipe(3275, 'Linen Bandage', BANDAGE, [[CLOTH, 1]], { profession: 'First Aid' })],
    demand: { 111: { [SPICES]: sells(20, 300, { lowPerDay: 20, newPerDay: 4, low3d: 290 }), [BANDAGE]: sells(30, 40, { lowPerDay: 30, newPerDay: 6, low3d: 38 }) } },
  } });
}

describe('Cerulean Dye at Ben\'s prices (yardstick 1)', () => {
  it('is a green craft to auction flip at the top of a list that also holds weaker flips, about 13s each', () => {
    const r = run(bensMarket());
    expect(r.report.complete).toBe(true);
    const top = r.flips[0]!;
    expect(top.key).toBe(DYE_KEY);
    expect(top.kind).toBe('craft');
    expect(top.family).toBe('craft_auction');
    // Sell: listed 75s00 x5, 75s01 x5, 75s50, 76s, 78s, 80s; sold recently at 75s50.
    //   market price = mean of the cheapest 30% (75s00 x5, 75s01 x5) = 75s00.5 -> 7501; claim = min(7500, 7501, 7550) = 7500.
    //   undercut = median gap of the cheapest levels (1, 49, 50, 200, 200) = 50c; post at 74s50; net = floor(7450 x 0.95) = 7077.
    expect(top.sellQuote.claimPrice).toBe(7500);
    expect(top.sellQuote.undercutPrice).toBe(7450);
    expect(top.sellQuote.netEach).toBe(7077);
    // Queue (round 1 finding H4, round 6): 60 a day low estimate, 12 a day new posts under him, 0 ahead, one unit per sale event.
    //   Sale events overnight are Poisson with mean (60 - 12) x 10/24 = 20; unit k sells when at least k events come.
    // Carryover: the dye has proven demand (60 a day low), so a unit unsold tonight sells tomorrow through tomorrow's
    //   queue ((60 - 12) = 48 sale events in the next 24 hours). Its 24 hour listing is still up for 14 of those hours,
    //   so 14/24 of tomorrow's sales pay no second deposit; the rest are relisted for one more 360c (round 6).
    // Best amount (round 5): the most expected profit among amounts whose risk is not high. The bad case (the 70s low
    //   nets 6650; half of tonight's sales; the rest relisted, and half of what tomorrow's queue would take sells) loses
    //   more than the expected profit past 23 crafts, so the best is 23, close to the 20 that sell tonight. An
    //   independent recompute picks the same amount.
    const safe = refBestSafe({ mu: 20, mu24: 48, ahead: 0, net: 7077, badNet: 6650, salvage: 75, deposit: 360, costAt: dyeCost, maxN: 38 });
    expect(safe.n).toBe(23);
    expect(top.best.units).toBe(23);
    expect(top.best.expectedSold).toBe(19.3);
    expect(top.best.soldTomorrow).toBe(3.7);
    // Cost: 46 lichen 2 x 2500 + 4 x 2700 + 10 x 2800 + 20 x 2900 + 10 x 3000 = 131,800, plus 5 bundles of vials 100
    expect(top.best.cost).toBe(131900);
    expect(dyeCost(23)).toBe(131900);
    // Per item: 7077 - 131900 / 23 = 1342.2, about 13s 42c.
    expect(top.perItem).toBe(1342);
    // Expected profit 30,316 (3g 3s 16c), bad case 28,646: under the expected profit, but over half of it: medium risk.
    expect(top.best.expectedProfit).toBe(30316);
    expect(Math.abs(top.best.expectedProfit - safe.e)).toBeLessThanOrEqual(1);
    expect(top.best.risk.badCaseLoss).toBe(28646);
    expect(Math.abs(top.best.risk.badCaseLoss - safe.bad)).toBeLessThanOrEqual(1);
    expect(top.best.risk.level).toBe('medium');
    expect(top.best.risk.atStake).toBe(131900 + 23 * 360);
    // The most profit regardless of risk is the whole lichen ladder: 38 crafts, 4g 42s 66c expected, high risk.
    const most = top.options.find(o => o.label === 'most')!;
    expect(most).toMatchObject({ units: 38, expectedProfit: 44266, note: 'most profit, higher risk' });
    expect(Math.abs(most.expectedProfit - refExpected({ mu: 20, mu24: 48, ahead: 0, net: 7077, salvage: 75, deposit: 360, cost: dyeCost(38), n: 38 }))).toBeLessThanOrEqual(1);
    expect(most.risk.level).toBe('high');
    expect(top.notes).toContain('about 3.7 more expected to sell tomorrow once relisted');
    // New listings under him overnight: 12 a day x 10/24 = 5, stated on the card.
    expect(top.sellQuote.newOvernight).toBeCloseTo(5, 6);
    expect(top.notes).toContain('about 5 new listings usually appear under you overnight');
    expect(top.buy.find(l => l.itemId === LICHEN)).toMatchObject({ kind: 'auction', units: 46 });
    expect(top.buy.find(l => l.itemId === VIAL)).toMatchObject({ kind: 'vendor', units: 25, unitPrice: 4 });
    expect(top.best.risk.drivers).toContain('thin supply of Frilled Lichen');
    // 46 of the 76 lichen listed: not three times deeper than it uses, so one opening, not repeatable
    expect(top.repeatable).toBe(false);
    // The weaker flips are on the same list, below it.
    const spices = r.flips.find(f => f.family === 'vendor_auction' && f.itemId === SPICES)!;
    const bandage = r.flips.find(f => f.itemId === BANDAGE)!;
    expect(spices.kind).toBe('flip');
    expect(bandage.kind).toBe('craft');
    expect(spices.rank).toBeGreaterThan(1);
    expect(bandage.rank).toBeGreaterThan(1);
    // Spices: claim 300, undercut median(1, 9) = 5, post 295, net 280, 120 each. Events overnight: (20 - 4) x 10/24 = 6.67.
    //   Unsold ones are relisted (one more 192c deposit) and sell tomorrow through tomorrow's queue, 20 - 4 = 16 events.
    //   The best amount is the most expected profit whose risk is not high (bad case at the 2s 90c low, net 275); the
    //   independent recompute and the engine agree on it to the copper.
    const sp = refBestSafe({ mu: (20 - 4) * 10 / 24, mu24: 20 - 4, ahead: 0, net: 280, badNet: 275, salvage: 40, deposit: 192, costAt: n => 160 * n, maxN: 30 });
    expect(spices.best.units).toBe(sp.n);
    expect(spices.best.expectedProfit).toBe(Math.round(sp.e));
    expect(spices.best.risk.level).not.toBe('high');
  });

  it('the first craft carries the whole 20c bundle of vials: 5000 + 20 = 5020', () => {
    const { e } = evalKey(inputsOf(ceruleanAtBens()), DYE_KEY);
    expect(e.at(1).cost).toBe(5020);
    // lichen 2 @25s, 4 @27s, 4 @28s; 5 vials are one bundle, nothing left over: 5004 + 2 x 5404 + 2 x 5604
    expect(e.at(5).cost).toBe(27020);
  });
});

describe('Bright Baubles on Blackwater (yardstick 2)', () => {
  const baubles = (demand: Parameters<typeof sells>[2] & { unitsPerDay: number }): Fixture => ({
    houses: [A, B],
    listings: { 111: [L(2589, 10, 5)], 116: [L(BAUBLES, 500, 10), L(BAUBLES, 501, 10), L(BAUBLES, 505, 10)] },
    items: [item(BAUBLES, 'Bright Baubles', 62), item(2589, 'Linen Cloth', 13)],
    vendors: { [BAUBLES]: [vendor('Old Man Heming', 250)] },
    demand: { 116: { [BAUBLES]: sells(demand.unitsPerDay, 500, { hours: 48, ...demand }) } },
  });
  const KEY = `vendor_auction:116:${BAUBLES}`;
  it('high sales: shows. 250c in, post at 4s97, 4s22 net after 15%, 1s72 each, 16 posted against a 14 7s 85c deposit each', () => {
    // the low estimate sets the queue (round 6): 48 a day here, the same as the middle
    const r = run(baubles({ unitsPerDay: 48, lowPerDay: 48, newPerDay: 4, low3d: 480 }));
    const f = r.flips.find(x => x.key === KEY)!;
    expect(f).toBeDefined();
    expect(f.kind).toBe('flip');
    // claim 500; undercut = median gap (1, 4) = 2.5 -> 3c; post 497; net floor(497 x 0.85) = 422; 422 - 250 = 172 each
    expect(f.sellQuote.netEach).toBe(422);
    expect(f.perItem).toBe(172);
    // Events overnight: (48 - 4) x 10/24 = 18.33. The Blackwater deposit is 5 x floor(62 x 0.2 x 24) = 1,485 a unit, so a
    //   unit pays only while P_k x 422 + (1 - P_k) x (62 - 1485) > 250, that is P_k > 0.907: the 13th (0.912) does, the
    //   14th (0.865) does not, with no carryover.
    //   Carryover (round 4, round 6): units unsold tonight are still listed for 14 of tomorrow's 24 hours (44 events
    //   tomorrow), so 14/24 of what tomorrow's queue takes sells with no second deposit. That carries the most profit
    //   regardless of risk to 16 units, 22s 88c, 15.3 tonight and 0.7 tomorrow, and the recompute agrees:
    const bb = refBest({ mu: (48 - 4) * 10 / 24, mu24: 48 - 4, ahead: 0, net: 422, salvage: 62, deposit: 1485, unitCost: 250, maxN: 30 });
    expect(bb.n).toBe(16);
    const most = f.options.find(o => o.label === 'most')!;
    expect(most).toMatchObject({ units: 16, expectedProfit: 2288, note: 'most profit, higher risk' });
    expect(most.expectedProfit).toBe(Math.round(bb.e));
    // Bad case at 16: under 72 hours of floors the 25% drop (375, net 318) is lower than the 480 low; half sell tonight,
    //   half of tomorrow's queue sells, 14/24 of that while the first listing is still up; relisting does not pay at 318
    //   against a 1,485 deposit, so the rest run out and go to a vendor. The recompute agrees: 9,240 lost.
    const badRef = Math.round(4000 - refRevenue({ mu: (48 - 4) * 10 / 24, mu24: 48 - 4, ahead: 0, net: 318, salvage: 62, deposit: 1485, n: 16, shortTonight: 0.5, shortTomorrow: 0.5 }));
    expect(Math.abs(most.risk.badCaseLoss - badRef)).toBeLessThanOrEqual(1);
    expect(most.risk.badCaseLoss).toBe(9240);
    expect(most.risk.level).toBe('high');
    // Round 5: no amount has a bad case under its expected profit (the unverified 14s 85c deposit is 3.5 times the net),
    //   so the best is the smallest that makes money, 1 unit (1s 72c), and the flip stays high risk.
    expect(refBestSafe({ mu: (48 - 4) * 10 / 24, mu24: 48 - 4, ahead: 0, net: 422, badNet: 318, salvage: 62, deposit: 1485, costAt: n => 250 * n, maxN: 30 }).n).toBe(0);
    expect(f.best.units).toBe(1);
    expect(f.best.expectedProfit).toBe(172);
    expect(f.best.risk.level).toBe('high');
    expect(f.notes.join(' ')).toMatch(/Blackwater deposit is not verified/);
    expect(f.buy[0]).toMatchObject({ kind: 'vendor', who: 'Old Man Heming', unitPrice: 250, units: 1 });
  });
  it('low sales: held back, and the reason says it sells under 1 a day', () => {
    const r = run(baubles({ unitsPerDay: 1, lowPerDay: 0.5, newPerDay: 0.2, recentSales: 1 }));
    expect(r.flips.find(x => x.key === KEY)).toBeUndefined();
    const h = r.heldBack.find(x => x.key === KEY)!;
    expect(h.code).toBe('sells under 1 a day');
    expect(h.reason).toBe('sells under 1 a day (low estimate 0.5 a day)');
  });
});

describe('today\'s prices (yardstick 3)', () => {
  it('lichen near 36s and the dye near 70s: held back, no profit after the cut', () => {
    const r = run(ceruleanAtBens({ lichen: [L(LICHEN, 3600, 20), L(LICHEN, 3700, 50)], dye: [L(DYE, 7000, 5), L(DYE, 7001, 5), L(DYE, 7050, 5), L(DYE, 7100, 5)],
      dyeDemand: { soldPrice: 7000, recentSoldPrice: 7000 } }));
    expect(r.flips.find(f => f.itemId === DYE)).toBeUndefined();
    // net about floor(6975 x 0.95) = 6626 against 2 x 3600 + 4 = 7204 for the cheapest craft
    expect(r.heldBack.find(h => h.key === DYE_KEY)).toMatchObject({ code: 'no profit after the cut', reason: 'no profit after the cut' });
  });
  it('baubles listed near 2s 60c on Blackwater: held back, no profit after the cut', () => {
    const r = run({ houses: [A, B], listings: { 111: [L(2589, 10, 5)], 116: [L(BAUBLES, 260, 10), L(BAUBLES, 261, 10), L(BAUBLES, 265, 10)] },
      items: [item(BAUBLES, 'Bright Baubles', 62), item(2589, 'Linen Cloth', 1)], vendors: { [BAUBLES]: [vendor('Old Man Heming', 250)] },
      demand: { 116: { [BAUBLES]: sells(48, 260, { hours: 48, lowPerDay: 40, newPerDay: 4 }) } } });
    // net floor((260 - 3) x 0.85) = 218 < 250
    expect(r.heldBack.find(h => h.key === `vendor_auction:116:${BAUBLES}`)).toMatchObject({ code: 'no profit after the cut' });
    expect(r.flips).toHaveLength(0);
  });
});

describe('today\'s junk stays out', () => {
  const HELM = 12640, BAR = 3575, ORE = 2772;
  it('a 3 listing product at 700g with no sales (Lionheart Helm) never shows', () => {
    const r = run({ listings: { 111: [L(BAR, 500, 100), ...many(HELM, 7_000_000, 3)] },
      items: [item(BAR, 'Iron Bar', 50), item(HELM, 'Lionheart Helm', 5000, { quality: 'EPIC', stackSize: 1 })],
      recipes: [recipe(9950, 'Lionheart Helm', HELM, [[BAR, 12]], { profession: 'Blacksmithing' })] });
    expect(r.flips).toHaveLength(0);
    expect(r.heldBack.find(h => h.itemId === HELM && h.family === 'craft_auction')).toMatchObject({ code: 'no sales near the price' });
  });
  it('a transmute chain respects its cooldown: one craft overnight, and two transmutes share it', () => {
    const DAY = 24 * 3600_000, EARTH = 7076, WATER = 7080, LIFE = 12803, AIR = 7082;
    const r = run({ listings: { 111: [L(LIFE, 2000, 100), L(AIR, 2000, 100), ...many(WATER, 40000, 6, 5), ...many(EARTH, 40000, 6, 5)] },
      items: [item(LIFE, 'Living Essence', 500), item(AIR, 'Essence of Air', 500), item(WATER, 'Essence of Water', 500), item(EARTH, 'Essence of Earth', 500)],
      recipes: [recipe(17563, 'Transmute: Life to Earth', EARTH, [[LIFE, 1]], { cooldownMs: DAY, cooldownCategory: 7 }),
        recipe(17562, 'Transmute: Air to Water', WATER, [[AIR, 1]], { cooldownMs: DAY, cooldownCategory: 7 })],
      demand: { 111: { [WATER]: sells(100, 40000, { lowPerDay: 100, newPerDay: 0 }), [EARTH]: sells(100, 40000, { lowPerDay: 100, newPerDay: 0 }) } } });
    const ts = r.flips.filter(f => f.recipeId === 17563 || f.recipeId === 17562);
    expect(ts).toHaveLength(2);
    // Standalone each may craft once in the 10 hour night (24 hour cooldown); after sharing, the second gets nothing.
    for (const f of ts) expect(f.best.units).toBe(1);
    expect(ts[0]!.afterShared).toMatchObject({ units: 1 });
    expect(ts[1]!.afterShared).toMatchObject({ units: 0, expectedProfit: 0 });
    expect(ts[1]!.shares).toContain(ts[0]!.key);
    expect(ts[0]!.notes.join(' ')).toMatch(/cooldown allows 1 craft in one crafting session/);
  });
  it('a bind on pickup product never sells on a house (Blizzard binding or game table Bonding 1)', () => {
    for (const bop of [{ binding: 'ON_ACQUIRE' }, { bonding: 1 }]) {
      const f = ceruleanAtBens();
      f.items = f.items.map(i => (i.id === DYE ? { ...i, ...bop } : i));
      const r = run(f);
      expect(r.flips.filter(f => f.sellHouseId != null && f.itemId === DYE)).toHaveLength(0);
      expect(r.heldBack.find(h => h.key === DYE_KEY)).toMatchObject({ code: 'bind on pickup' });
    }
  });
  it('a random yield recipe never ranks', () => {
    const f = ceruleanAtBens();
    f.recipes = [recipe(DYE_RECIPE, 'Cerulean Dye', DYE, [[LICHEN, 2], [VIAL, 1]], { randomYield: true, qtyMin: 1, qtyMax: 3 })];
    const r = run(f);
    expect(r.flips.filter(x => x.recipeId === DYE_RECIPE)).toHaveLength(0);
    expect(r.heldBack.find(h => h.key === DYE_KEY)).toMatchObject({ code: 'random yield' });
  });
  it('a recipe not live in Forever never ranks', () => {
    const f = ceruleanAtBens();
    f.recipes = [recipe(DYE_RECIPE, 'Cerulean Dye', DYE, [[LICHEN, 2], [VIAL, 1]], { live: false })];
    expect(run(f).heldBack.find(h => h.key === DYE_KEY)).toMatchObject({ code: 'not live' });
  });
  it('a reagent priced far above its vendor value with deep listings (Strange Dust) is still a cost', () => {
    const DUST = 10940, OIL = 20744;
    // Strange Dust: vendor value 1c, listed deep at 1s 20c (120 times). The sell side would call that a troll; the cost side buys it.
    const r = run({ listings: { 111: [...many(DUST, 120, 20, 20), ...many(OIL, 1000, 6, 5)] },
      items: [item(DUST, 'Strange Dust', 1), item(OIL, 'Minor Wizard Oil', 100)],
      recipes: [recipe(25124, 'Minor Wizard Oil', OIL, [[DUST, 2]], { profession: 'Enchanting' })],
      demand: { 111: { [OIL]: sells(48, 1000, { lowPerDay: 48, newPerDay: 0 }) } } });
    const f = r.flips.find(x => x.itemId === OIL)!;
    expect(f).toBeDefined();
    expect(f.buy.find(l => l.itemId === DUST)).toMatchObject({ kind: 'auction', unitPrice: 120 });
  });
});

describe('effort never buries crafting', () => {
  it('2,000 crafts for 12c each: shown, ranked far below; best stays in one 30 minute session, most shows all 100 minutes', () => {
    const CHEAP = 4306, KIT = 4304;
    const f = bensMarket();
    f.listings[111]!.push(...many(CHEAP, 98, 20, 100));
    f.items.push(item(CHEAP, 'Silk Cloth', 25), item(KIT, 'Silk Kit', 110));
    f.recipes!.push(recipe(9000, 'Silk Kit', KIT, [[CHEAP, 1]], { profession: 'Tailoring' }));
    const r = run(f);
    const kit = r.flips.find(x => x.itemId === KIT)!;
    expect(kit.family).toBe('craft_vendor');
    // One 30 minute session at 3 seconds a cast is 600 crafts: 600 x 12c = 7,200 (72s)
    expect(kit.best.units).toBe(600);
    expect(kit.best.castMinutes).toBe(30);
    expect(kit.best.expectedProfit).toBe(7200);
    expect(kit.best.note).toBeUndefined();
    // The most row: all 2,000 listed at 98c, sold to a vendor at 1s 10c: 12c x 2,000 = 24,000 (2g 40s), 100 minutes of casting
    const most = kit.options.find(o => o.label === 'most')!;
    expect(most.units).toBe(2000);
    expect(most.expectedProfit).toBe(24000);
    expect(most.minutes).toBeGreaterThanOrEqual(100);
    expect(most.note).toBe('100 minutes of crafting, more than one 30 minute session');
    expect(kit.notes.join(' ')).toMatch(/one 30 minute crafting session/);
    expect(kit.rank).toBeGreaterThan(r.flips.find(x => x.key === DYE_KEY)!.rank!);
    // At 2c a craft (a 1s vendor price) it is under the 5c vendor margin and held back (round 2 M3)
    const thin = bensMarket();
    thin.listings[111]!.push(...many(CHEAP, 98, 20, 100));
    thin.items.push(item(CHEAP, 'Silk Cloth', 25), item(KIT, 'Silk Kit', 100));
    thin.recipes!.push(recipe(9000, 'Silk Kit', KIT, [[CHEAP, 1]], { profession: 'Tailoring' }));
    expect(run(thin).heldBack.find(h => h.itemId === KIT && h.family === 'craft_vendor')).toMatchObject({ code: 'vendor margin too thin' });
  });
  it('a craft and a plain flip with equal expected profit rank side by side', () => {
    const P = 9101, V = 9102, R = 9103;
    const ladder = (id: number) => [L(id, 1000, 10), L(id, 1001, 10), L(id, 1010, 10)];
    const r = run({ listings: { 111: [...ladder(P), ...ladder(V), L(2589, 10, 5)] },
      items: [item(P, 'Crafted Thing', 100), item(V, 'Vendor Thing', 100), item(R, 'Vendor Reagent', 50), item(2589, 'Linen Cloth', 13)],
      vendors: { [V]: [vendor('Trader', 500)], [R]: [vendor('Supplier', 500)] },
      recipes: [recipe(9200, 'Crafted Thing', P, [[R, 1]], { castMs: 10_000 })],
      demand: { 111: { [P]: sells(48, 1000, { lowPerDay: 48, newPerDay: 0 }), [V]: sells(48, 1000, { lowPerDay: 48, newPerDay: 0 }) } } });
    const craft = r.flips.find(x => x.itemId === P)!, plain = r.flips.find(x => x.itemId === V)!;
    expect(craft.best.expectedProfit).toBe(plain.best.expectedProfit);
    expect(craft.best.minutes).toBeGreaterThan(plain.best.minutes);
    expect(Math.abs(craft.rank! - plain.rank!)).toBe(1);
  });
});

describe('other families', () => {
  it('auction to vendor: listings under what a vendor pays, every unit counts', () => {
    const r = run({ listings: { 111: [L(2589, 10, 20), L(2589, 14, 14), L(2589, 16, 50)] }, items: [item(2589, 'Linen Cloth', 20)] });
    const f = r.flips.find(x => x.family === 'auction_vendor')!;
    // (20 - 10) x 20 + (20 - 14) x 14 = 284; the 16c listing clears 4c, under the 5c vendor margin (round 2 M3)
    expect(f.best.units).toBe(34);
    expect(f.best.expectedProfit).toBe(284);
    expect(f.sell).toMatchObject({ kind: 'any_vendor', unitPrice: 20 });
    expect(f.repeatable).toBe(false);
  });
  it('cross house: buy on Alliance 111, sell on Blackwater', () => {
    const WOOL = 2592;
    const r = run({ houses: [A, B], listings: { 111: [L(WOOL, 100, 40)], 116: [L(WOOL, 300, 10), L(WOOL, 301, 10), L(WOOL, 305, 10)] },
      items: [item(WOOL, 'Wool Cloth', 33)], demand: { 116: { [WOOL]: sells(48, 300, { lowPerDay: 48, newPerDay: 0, hours: 48 }) } } });
    const f = r.flips.find(x => x.family === 'cross_house')!;
    expect(f.key).toBe(`cross_house:116:${WOOL}`);
    expect(f.buy[0]).toMatchObject({ kind: 'auction', houseId: 111, unitPrice: 100 });
    // post at 297 (undercut 3c), net floor(297 x 0.85) = 252; 152 each; 20 sale events expected overnight, but with a
    //   790c deposit (5 x floor(33 x 0.2 x 24)); unsold units sell tomorrow (48 events in tomorrow's queue), 14/24 of
    //   them while tonight's listing is still up (round 6). The most profit is 19 units (the recompute agrees), but no amount has a bad case under its expected profit
    //   (the 25% drop to 2s 25c nets 191 against a 790c deposit), so the best is 1 unit and the flip stays high risk.
    expect(f.perItem).toBe(152);
    const wb = refBest({ mu: 20, mu24: 48, ahead: 0, net: 252, salvage: 33, deposit: 790, unitCost: 100, maxN: 40 });
    expect(wb.n).toBe(19);
    expect(f.options.find(o => o.label === 'most')).toMatchObject({ units: 19, expectedProfit: Math.round(wb.e) });
    expect(f.best.units).toBe(1);
    expect(f.best.risk.level).toBe('high');
  });
  it('cheap listing: bought well under the typical floor and relisted near it', () => {
    const ORE = 2770;
    const r = run({ listings: { 111: [L(ORE, 60, 10), ...many(ORE, 100, 6, 10)] }, items: [item(ORE, 'Copper Ore', 5)],
      typical: { 111: { [ORE]: 100 } }, demand: { 111: { [ORE]: sells(96, 100, { lowPerDay: 96, newPerDay: 0 }) } } });
    const f = r.flips.find(x => x.family === 'cheap_listing')!;
    // claim min(typical 100, judged 100) = 100, single price level above the line -> 1% undercut = 1c, post 99, net floor(94.05) = 94; 34 each on 10 units
    expect(f.best.units).toBe(10);
    expect(f.perItem).toBe(34);
    expect(f.repeatable).toBe(false);
  });
  it('disenchant has no data source yet: nothing is invented and the report says so', () => {
    const r = run(bensMarket());
    expect(r.flips.some(f => f.family === 'disenchant')).toBe(false);
    expect(r.report.suspects.join(' ')).toMatch(/disenchant/);
  });
  it('a price that just jumped is rising only with sweep evidence, and ranks on the proven price', () => {
    const jumped = (sweepHigh: number | null) => run(ceruleanAtBens({ dye: [L(DYE, 9000, 5), L(DYE, 9001, 5), L(DYE, 9050, 5)], dyeDemand: { soldPrice: 7550, recentSoldPrice: 7550, sweepHigh } }));
    const withSweep = jumped(9000).flips.find(f => f.key === DYE_KEY)!;
    expect(withSweep.opening).toBe('rising');
    expect(withSweep.sellQuote.claimPrice).toBe(7550);
    expect(withSweep.sellQuote.upTo).toBe(9000);
    const without = jumped(null).flips.find(f => f.key === DYE_KEY)!;
    expect(without.opening).toBe('new');
    expect(without.sellQuote.claimPrice).toBe(7550);
  });
});

describe('the cautious sales inputs', () => {
  it('with no low estimate from sale counting, one is worked out from sale EVENTS, never units (round 1 H1)', () => {
    // 3 sale events in 6 hours that took 284 units (221, 48 and 15). The one sided 95% Poisson lower bound on 3 events is
    // 0.8177 (half the chi square 5% quantile with 6 degrees of freedom, 1.6354 / 2): 0.8177 x 284/3 units over 6 hours,
    // 12.9 units an hour at most cautious, 309.7 a day; the middle estimate (284 in 6 hours) is 1,136 a day.
    const d = { unitsPerDay: 1136, hours: 6, snapshots: 6, saleEvents: 3, unitsPerEvent: 284 / 3 };
    expect(lowPerDay(d).value).toBeCloseTo((0.81770 * (284 / 3) / 6) * 24, 0);
    expect(lowPerDay(d).derived).toBe(true);
    // Counted as units (284 events of 1), the same sales would claim a low near 1,000 a day: the event count is the honest one.
    expect(lowPerDay({ ...d, saleEvents: 284, unitsPerEvent: 1 }).value!).toBeGreaterThan(3 * lowPerDay(d).value!);
    // 0 events: a low of 0; under 6 hours the hours count as 6, so 1 event in the first hour is never 24 a day
    expect(lowPerDay({ ...d, saleEvents: 0 }).value).toBe(0);
    expect(lowPerDay({ unitsPerDay: 24, hours: 1, snapshots: 1, saleEvents: 1, unitsPerEvent: 1 }).value).toBeCloseTo((0.05129 / 6) * 24, 3);
    // No event count at all: unknown, never projected from units
    expect(lowPerDay({ unitsPerDay: 60, hours: 72, snapshots: 72 }).value).toBeNull();
    // Sale counting's own low wins
    expect(lowPerDay({ unitsPerDay: 60, hours: 72, snapshots: 72, lowPerDay: 33 }).value).toBe(33);
  });
  it('the Poisson helpers match the textbook values', () => {
    // one sided 95% lower bounds: 1 event 0.0513, 2 events 0.3554, 5 events 1.9701, 10 events 5.4254
    expect(poissonLowerBound(1)).toBeCloseTo(0.05129, 4);
    expect(poissonLowerBound(2)).toBeCloseTo(0.35536, 4);
    expect(poissonLowerBound(5)).toBeCloseTo(1.97015, 4);
    expect(poissonLowerBound(10)).toBeCloseTo(5.42540, 4);
    // a fractional count bounds like the whole events under it
    expect(poissonLowerBound(2.9)).toBe(poissonLowerBound(2));
    // tails against a direct sum of the pmf, small and large means
    for (const mu of [0.5, 6.67, 20, 500]) {
      const t = poissonTail(mu, Math.ceil(mu * 1.5) + 5);
      for (const j of [0, 1, Math.floor(mu), Math.ceil(mu * 1.2)]) expect(t[j]!).toBeCloseTo(refTail(mu, j), 9);
    }
    // a mean past where exp(-mu) underflows still works (log space): P(X >= mu) is about a half
    expect(poissonTail(2000, 2000)[2000]!).toBeCloseTo(0.5, 1);
  });
  it('one typical undercut is the median gap between the cheapest price levels, within 1c and 5%', () => {
    expect(typicalUndercut([{ unitPrice: 7500 }, { unitPrice: 7501 }, { unitPrice: 7550 }, { unitPrice: 7600 }, { unitPrice: 7800 }, { unitPrice: 8000 }], 7500)).toBe(50);
    expect(typicalUndercut([{ unitPrice: 100 }, { unitPrice: 100 }], 100)).toBe(1);
    expect(typicalUndercut([{ unitPrice: 1000 }, { unitPrice: 1150 }], 1000)).toBe(50);
    // a level over 1.2 times the claim is a troll, not an undercut: one 5g listing leaves the gap alone (system review round 1)
    expect(typicalUndercut([{ unitPrice: 7500 }, { unitPrice: 7501 }, { unitPrice: 7550 }, { unitPrice: 7600 }, { unitPrice: 7800 }, { unitPrice: 50000 }], 7500)).toBe(50);
    expect(typicalUndercut([{ unitPrice: 100 }, { unitPrice: 200 }], 100)).toBe(1);
  });
});
