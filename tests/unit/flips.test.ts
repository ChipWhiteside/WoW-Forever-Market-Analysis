import { describe, it, expect } from 'vitest';
import { A, B, L, many, item, vendor, recipe, sells, inputsOf, evalKey, run, ceruleanAtBens, LICHEN, VIAL, DYE, BAUBLES, DYE_RECIPE, type Fixture } from './flips.fixture.ts';
import { lowPerDay, typicalUndercut } from '../../src/flips/sellBook.ts';

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
    // Queue: 60 a day low, 12 a day new posts under him, 0 ahead: 60 x 10/24 - 12 x 10/24 = 25 - 5 = 20 overnight.
    expect(top.best.units).toBe(20);
    expect(top.best.expectedSold).toBe(20);
    // Cost of 20 crafts walking the lichen ladder (2 @25s, 4 @27s, 10 @28s, 20 @29s, then 30s), 1 vial each at 4c:
    //   5004 + 2 x 5404 + 5 x 5604 + 10 x 5804 + 2 x 6004 = 113,880 (20 vials are exactly 4 bundles of 5, nothing wasted)
    expect(top.best.cost).toBe(113880);
    // Per item: 7077 - 113880 / 20 = 7077 - 5694 = 1383, about 13s 83c.
    expect(top.perItem).toBe(1383);
    // Expected profit: 20 x 7077 - 113,880 = 27,660 (2g 76s 60c).
    expect(top.best.expectedProfit).toBe(27660);
    // Bad case: the dye falls to its 3 day low of 70s, net floor(7000 x 0.95) = 6650 x 20 = 133,000, still over cost: risk low.
    expect(top.best.risk.level).toBe('low');
    expect(top.best.risk.badCaseLoss).toBe(0);
    expect(top.buy.find(l => l.itemId === LICHEN)).toMatchObject({ kind: 'auction', units: 40 });
    expect(top.buy.find(l => l.itemId === VIAL)).toMatchObject({ kind: 'vendor', units: 20, unitPrice: 4 });
    // 40 of the 76 lichen listed: not three times deeper than it uses, so one opening, not repeatable
    expect(top.repeatable).toBe(false);
    // The weaker flips are on the same list, below it.
    const spices = r.flips.find(f => f.family === 'vendor_auction' && f.itemId === SPICES)!;
    const bandage = r.flips.find(f => f.itemId === BANDAGE)!;
    expect(spices.kind).toBe('flip');
    expect(bandage.kind).toBe('craft');
    expect(spices.rank).toBeGreaterThan(1);
    expect(bandage.rank).toBeGreaterThan(1);
    // Spices: claim 300, undercut median(1, 9) = 5, post 295, net 280, 120 each. Queue 20 x 10/24 - 4 x 10/24 = 6.67.
    //   6 units: 6 x 280 - 6 x 160 = 720. 7 units: 6.67 x 280 - 1120 - 0.33 x 192 deposit = 683. Best 6, 7s 20c.
    expect(spices.best.units).toBe(6);
    expect(spices.best.expectedProfit).toBe(720);
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
  it('high sales: shows. 250c in, post at 4s97, 4s22 net after 15%, 1s72 each, 15 sell overnight', () => {
    const r = run(baubles({ unitsPerDay: 48, lowPerDay: 40, newPerDay: 4, low3d: 480 }));
    const f = r.flips.find(x => x.key === KEY)!;
    expect(f).toBeDefined();
    expect(f.kind).toBe('flip');
    // claim 500; undercut = median gap (1, 4) = 2.5 -> 3c; post 497; net floor(497 x 0.85) = 422; 422 - 250 = 172 each
    expect(f.sellQuote.netEach).toBe(422);
    expect(f.perItem).toBe(172);
    // queue: 40 x 10/24 - 4 x 10/24 = 15 units; 15 x 172 = 2,580
    expect(f.best.units).toBe(15);
    expect(f.best.expectedProfit).toBe(2580);
    expect(f.notes.join(' ')).toMatch(/Blackwater deposit is not verified/);
    expect(f.buy[0]).toMatchObject({ kind: 'vendor', who: 'Old Man Heming', unitPrice: 250, units: 15 });
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
    expect(ts[0]!.notes.join(' ')).toMatch(/cooldown allows 1 craft tonight/);
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
  it('2,000 crafts for 2c each: shown, ranked far below, with its 100 minutes of casting on the card', () => {
    const CHEAP = 4306, KIT = 4304;
    const f = bensMarket();
    f.listings[111]!.push(...many(CHEAP, 98, 20, 100));
    f.items.push(item(CHEAP, 'Silk Cloth', 25), item(KIT, 'Silk Kit', 100));
    f.recipes!.push(recipe(9000, 'Silk Kit', KIT, [[CHEAP, 1]], { profession: 'Tailoring' }));
    const r = run(f);
    const kit = r.flips.find(x => x.itemId === KIT)!;
    expect(kit.family).toBe('craft_vendor');
    // 2,000 units bought at 98c, sold to a vendor at 100c: 2c x 2,000 = 4,000 (40s)
    expect(kit.best.units).toBe(2000);
    expect(kit.best.expectedProfit).toBe(4000);
    // 2,000 casts x 3 seconds = 100 minutes, plus buying and the vendor sale
    expect(kit.best.minutes).toBeGreaterThanOrEqual(100);
    expect(kit.rank).toBeGreaterThan(r.flips.find(x => x.key === DYE_KEY)!.rank!);
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
    const r = run({ listings: { 111: [L(2589, 10, 20), L(2589, 12, 14), L(2589, 13, 50)] }, items: [item(2589, 'Linen Cloth', 13)] });
    const f = r.flips.find(x => x.family === 'auction_vendor')!;
    // (13 - 10) x 20 + (13 - 12) x 14 = 74; the 13c listing makes nothing
    expect(f.best.units).toBe(34);
    expect(f.best.expectedProfit).toBe(74);
    expect(f.sell).toMatchObject({ kind: 'any_vendor', unitPrice: 13 });
    expect(f.repeatable).toBe(false);
  });
  it('cross house: buy on Alliance 111, sell on Blackwater', () => {
    const WOOL = 2592;
    const r = run({ houses: [A, B], listings: { 111: [L(WOOL, 100, 40)], 116: [L(WOOL, 300, 10), L(WOOL, 301, 10), L(WOOL, 305, 10)] },
      items: [item(WOOL, 'Wool Cloth', 33)], demand: { 116: { [WOOL]: sells(48, 300, { lowPerDay: 48, newPerDay: 0, hours: 48 }) } } });
    const f = r.flips.find(x => x.family === 'cross_house')!;
    expect(f.key).toBe(`cross_house:116:${WOOL}`);
    expect(f.buy[0]).toMatchObject({ kind: 'auction', houseId: 111, unitPrice: 100 });
    // post at 297 (undercut 3c), net floor(297 x 0.85) = 252; 152 each; 48 x 10/24 = 20 sell overnight
    expect(f.perItem).toBe(152);
    expect(f.best.units).toBe(20);
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
  it('with no low estimate from sale counting, one is worked out from the sales seen', () => {
    // 60 a day over 72 hours is 180 seen; 180 - 1.645 x sqrt(180) = 157.93; over 72 hours that is 52.64 a day
    expect(lowPerDay({ unitsPerDay: 60, hours: 72, snapshots: 72 }).value).toBeCloseTo(52.64, 2);
    // one hour of watching counts as 6, so 4 sold an hour reads 16 a day middle, and the low is far under it
    expect(lowPerDay({ unitsPerDay: 16, hours: 1, snapshots: 1 }).value).toBeCloseTo(((4 - 1.645 * 2) / 6) * 24, 5);
    expect(lowPerDay({ unitsPerDay: 60, hours: 72, snapshots: 72, lowPerDay: 33 }).value).toBe(33);
  });
  it('one typical undercut is the median gap between the cheapest price levels, within 1c and 5%', () => {
    expect(typicalUndercut([{ unitPrice: 7500 }, { unitPrice: 7501 }, { unitPrice: 7550 }, { unitPrice: 7600 }, { unitPrice: 7800 }, { unitPrice: 8000 }], 7500)).toBe(50);
    expect(typicalUndercut([{ unitPrice: 100 }, { unitPrice: 100 }], 100)).toBe(1);
    expect(typicalUndercut([{ unitPrice: 100 }, { unitPrice: 200 }], 100)).toBe(5);
  });
});
