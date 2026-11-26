/**
 * Round 2 of independent testing (November 25) matched 40 real flips and 12 Poisson recomputes to the copper and found
 * these faults in the model. One test per finding (H1 is in flips-round2.test.ts, "carryover through the same queue").
 */
import { describe, it, expect } from 'vitest';
import { A, L, many, item, recipe, sells, inputsOf, evalKey, run, ceruleanAtBens, DYE, DYE_RECIPE } from './flips.fixture.ts';
import { SellBook, overnightQueue, normalCdf } from '../../src/flips/sellBook.ts';
import { runFlips } from '../../src/flips/run.ts';
import { buildFlipInputs, parseProfessions } from '../../src/flips/inputs.ts';
import { newPostsFromRaw, newPerDayAt } from '../../src/flips/newPosts.ts';
import { cooldownCrafts } from '../../src/flips/market.ts';
import { UNKNOWN_LEARN } from '../../src/flips/run.ts';
import { openDb } from '../../src/store/db.ts';
import { rawPath, writeRaw } from '../../src/engine/rawstore.ts';
import { tempDir } from '../helpers.ts';

const DYE_KEY = `craft_auction:111:${DYE}:${DYE_RECIPE}`;
const HOUR = 3600_000;

describe('H2: new posts at or under Chip\'s post price, after 6 hours', () => {
  it('counts only new listings at or under the post price, from the raw publishes, and none before 6 hours', () => {
    const dir = tempDir();
    const d = openDb(dir);
    d.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES (111, 'Alliance Auction House', 'alliance', 0.05, 1, 0)`);
    const ITEM = 4306;
    let id = 1;
    // Each hour two new listings appear: 5 units at 90c (under a 95c post) and 7 units at 120c (over it); one old stays.
    const keep = { id: id++, itemId: ITEM, quantity: 3, unitPrice: 80, timeLeft: 'LONG' as const };
    const publish = (h: number) => {
      const t = h * HOUR;
      const ls = [keep, ...(h > 0 ? [{ id: id++, itemId: ITEM, quantity: 5, unitPrice: 90, timeLeft: 'LONG' as const }, { id: id++, itemId: ITEM, quantity: 7, unitPrice: 120, timeLeft: 'LONG' as const }] : [])];
      for (const kind of ['auctions', 'commodities']) {
        writeRaw(rawPath(dir, 111, kind, t), kind === 'commodities' ? ls : []);
        const sid = d.prepare('INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, diff_hours) VALUES (111, ?, ?, ?, ?, 0, 0, 0, ?)')
          .run(kind, `${kind}${t}`, t, t, h > 0 ? 1 : null).lastInsertRowid;
        // sale counting's publishes are the differenced ones with rows counted at a sold price: new posts read the same ones
        if (h > 0) d.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder, gone_units, sold_value)
          VALUES (?, 111, 1, ?, NULL, 0, 0, 0, 0, '[]', 0, 0)`).run(sid, t);
      }
    };
    for (let h = 0; h <= 8; h++) publish(h);
    // at 5 hours: 5 hours watched, under the 6 hour minimum: not measured
    expect(newPerDayAt(newPostsFromRaw(d, 111, 5 * HOUR)!, ITEM, 95)).toBeNull();
    // at 8 hours: 8 hours, 8 x 5 units at 90c under the 95c post (the 120c ones are over it): 40 / 8 x 24 = 120 a day
    const np = newPostsFromRaw(d, 111, 8 * HOUR)!;
    expect(np.hours).toBe(8);
    expect(newPerDayAt(np, ITEM, 95)).toBe(120);
    expect(newPerDayAt(np, ITEM, 120)).toBe((8 * 12 / 8) * 24);
    expect(newPerDayAt(np, ITEM, 85)).toBe(0);
    // posts up to 1.05 times the post price compete (a slow undercutter posts just above a price that has since fallen)
    expect(newPerDayAt(np, ITEM, 115)).toBe((8 * 12 / 8) * 24);
    expect(newPerDayAt(np, ITEM, 114)).toBe(120);
    // the flip inputs carry it, and the sell book uses it at the item's own post price
    const inputs = buildFlipInputs(d, new Map([[111, [L(ITEM, 100, 10), L(ITEM, 100, 10)]]]), 8 * HOUR);
    expect(inputs.newPosts!.get(111)!.hours).toBe(8);
  });
  it('a cheap listing counts new posts at its own relist price, not the base quote\'s', () => {
    const ORE = 2770;
    const inputs = inputsOf({ listings: { 111: [L(ORE, 50, 10), ...many(ORE, 100, 6, 10)] }, items: [item(ORE, 'Copper Ore', 5)],
      typical: { 111: { [ORE]: 90 } }, demand: { 111: { [ORE]: sells(96, 100, { lowPerDay: 96, newPerDay: 0 }) } } });
    // 48 new units at 95c in 24 hours: under the base post (99c), over the cheap listing's relist price (90 - 1 = 89c)
    inputs.newPosts = new Map([[111, { hours: 24, byItem: new Map([[ORE, [[95, 48]] as Array<[number, number]>]]) }]]);
    const { c } = evalKey(inputs, `cheap_listing:111:${ORE}`);
    expect(c.quote.undercutPrice).toBe(89);
    expect(c.quote.newPerHour).toBe(0);
    // at the base quote's 99c post the same publishes count 48 a day
    expect(newPerDayAt(inputs.newPosts.get(111), ORE, 99)).toBe(48);
  });
  it('without raw publishes, sale counting\'s count is used, but not before 6 hours watched', () => {
    const early = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { newPerDay: 48, hours: 4, hoursWatched: 4 } }))).quote(A, DYE)!;
    expect(early.newPerHour).toBe(0);
    expect(early.newDerived).toBe(true);
    const later = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { newPerDay: 48, hours: 6, hoursWatched: 6 } }))).quote(A, DYE)!;
    expect(later.newPerHour).toBe(2);
  });
});

describe('H3: every profession a craft tree uses', () => {
  // Felcloth Thing (Tailoring 310) needs an Essence (Alchemy 275, a transmute) that needs a Bar (Mining 150) from ore.
  const ORE = 900101, BAR = 900102, ESS = 900103, THING = 900104;
  const fixture = (extra: { essListed?: boolean; mine?: string } = {}) => ({
    listings: { 111: [L(ORE, 10, 200), ...(extra.essListed ? [L(ESS, 400, 500)] : []), ...many(THING, 5000, 6, 5)] },
    items: [item(ORE, 'Ore', 1), item(BAR, 'Bar', 1), item(ESS, 'Essence', 1), item(THING, 'Felcloth Thing', 100)],
    recipes: [recipe(1, 'Smelt Bar', BAR, [[ORE, 2]], { profession: 'Mining', learnSkill: 150 }),
      recipe(2, 'Transmute: Essence', ESS, [[BAR, 2]], { profession: 'Alchemy', learnSkill: 275 }),
      recipe(3, 'Felcloth Thing', THING, [[ESS, 1]], { profession: 'Tailoring', learnSkill: 310 })],
    demand: { 111: { [THING]: sells(48, 5000, { lowPerDay: 48, newPerDay: 0 }) } },
    settings: extra.mine ? { myProfessions: parseProfessions(extra.mine) } : undefined,
  });
  it('a three profession trace lists all three, with the skill each needs, as a note and never a gate', () => {
    const f = run(fixture()).flips.find(x => x.itemId === THING && x.family === 'craft_auction')!;
    expect(f).toBeDefined();
    expect(f.setup!.needs!.map(n => [n.profession, n.rank])).toEqual(expect.arrayContaining([['Tailoring', 310], ['Alchemy', 275], ['Mining', 150]]));
    expect(f.setup!.needs).toHaveLength(3);
    expect(f.setup!.needsText).toMatch(/^needs Tailoring 310, /);
    expect(f.setup!.needsText).toContain('Alchemy 275 (Transmute: Essence)');
    expect(f.setup!.needsText).toContain('Mining 150 (Smelt Bar)');
    expect(f.notes.join(' ')).toMatch(/3 professions \(an alt may cover one\)/);
  });
  it('my_professions: a sub craft in a profession Chip lacks is bought when listed; the top recipe is never blocked', () => {
    // Chip has Tailoring only; the Essence is listed, so it is bought, not transmuted
    const f = run(fixture({ essListed: true, mine: '["Tailoring"]' })).flips.find(x => x.itemId === THING && x.family === 'craft_auction')!;
    expect(f.buy.find(l => l.itemId === ESS)).toMatchObject({ kind: 'auction' });
    expect(f.buy.some(l => l.kind === 'craft' && l.who.startsWith('Alchemy'))).toBe(false);
    expect(f.setup!.needs!.map(n => n.profession)).toEqual(['Tailoring']);
    // unset: the cheaper transmute chain is used and listed
    const open = run(fixture({ essListed: true })).flips.find(x => x.itemId === THING && x.family === 'craft_auction')!;
    expect(open.setup!.needs!.length).toBe(3);
    // Chip has no Tailoring: the card's recipe is still offered (it can be trained)
    expect(run(fixture({ mine: '{"Alchemy": 300, "Mining": 300}' })).flips.find(x => x.itemId === THING)).toBeDefined();
    // with nothing to buy the Essence from, it is still crafted (and listed) rather than lost
    const none = run(fixture({ mine: '["Tailoring"]' })).flips.find(x => x.itemId === THING && x.family === 'craft_auction')!;
    expect(none.setup!.needs!.length).toBe(3);
    // a skill below the recipe counts as lacking it
    expect(parseProfessions('{"Alchemy": 250}')!.get('Alchemy')).toBe(250);
    expect(parseProfessions('nonsense')).toBeNull();
  });
});

describe('H4: a recipe nobody knows how to learn yet', () => {
  it('the card says so and it is a risk driver', () => {
    const u = ceruleanAtBens();
    u.recipes = u.recipes!.map(r => ({ ...r, learnSource: null }));
    const f = run(u).flips.find(x => x.key === DYE_KEY)!;
    expect(f.setup).toMatchObject({ where: UNKNOWN_LEARN, unknown: true });
    expect(f.notes).toContain(UNKNOWN_LEARN);
    expect(f.best.risk.drivers).toContain(UNKNOWN_LEARN);
    expect(f.options.every(o => o.risk.level !== 'low')).toBe(true); // an unknown learn source is never low risk
    // a known source is not flagged
    const g = ceruleanAtBens();
    g.recipes = g.recipes!.map(r => ({ ...r, learnSource: 'auto' }));
    const known = run(g).flips.find(x => x.key === DYE_KEY)!;
    expect(known.setup).toMatchObject({ where: 'known when the profession is learned' });
    expect(known.best.risk.drivers).not.toContain(UNKNOWN_LEARN);
  });
});

describe('M2: cooldowns inside one crafting session', () => {
  it('1 + floor(session / cooldown) crafts, a shared category counted once', () => {
    expect(cooldownCrafts({ cooldownMs: 24 * HOUR }, 30)).toBe(1);
    expect(cooldownCrafts({ cooldownMs: 10 * 60_000 }, 30)).toBe(4);
    expect(cooldownCrafts({ cooldownMs: null }, 30)).toBe(Infinity);
    const SALT = 15409, RAW = 900200;
    const r = run({ listings: { 111: [L(RAW, 10, 100), ...many(SALT, 1000, 6, 5)] }, items: [item(RAW, 'Deeprock Salt', 1), item(SALT, 'Refined Deeprock Salt', 50)],
      recipes: [recipe(15409, 'Refined Deeprock Salt', SALT, [[RAW, 1]], { cooldownMs: 10 * 60_000, cooldownCategory: 9, profession: 'Leatherworking', kind: 'conversion' })],
      demand: { 111: { [SALT]: sells(96, 1000, { lowPerDay: 96, newPerDay: 0 }) } } });
    const f = r.flips.find(x => x.itemId === SALT && x.sellHouseId != null)!;
    expect(f.best.units).toBe(4);
    expect(f.notes.join(' ')).toMatch(/cooldown allows 4 crafts in one crafting session/);
    // the tool it needs is named (Classic knowledge, unverified)
    expect(f.setup!.tools).toEqual(['Salt Shaker']);
  });
});

describe('M3: vendor price trust', () => {
  it('a vendor price only from Classic data is held back; a Forever one needs 5c and 5% a unit', () => {
    const LINEN = 2589;
    const classic = run({ listings: { 111: [L(LINEN, 10, 20)] }, items: [item(LINEN, 'Linen Cloth', 20, { dataSource: 'classic1x' })] });
    expect(classic.flips).toHaveLength(0);
    expect(classic.heldBack.find(h => h.family === 'auction_vendor')).toMatchObject({ code: 'vendor_unverified', reason: 'vendor price comes from Classic data, not confirmed in Forever' });
    // 1g vendor price: the margin is 5% (5s); a 4s margin is held back, a 6s one passes
    const big = (cost: number) => run({ listings: { 111: [L(LINEN, cost, 20)] }, items: [item(LINEN, 'Big Thing', 10000, { dataSource: 'forever' })] });
    expect(big(9600).heldBack.find(h => h.family === 'auction_vendor')).toMatchObject({ code: 'vendor margin too thin' });
    expect(big(9400).flips.find(x => x.family === 'auction_vendor')).toBeDefined();
  });
});

describe('M4: a product that sells better on the auction house', () => {
  it('the vendor card names the auction price; a cooldown recipe\'s vendor path is held back when auctions pay more', () => {
    const RAW = 900300, OUT = 900301;
    const base = (cooldownMs: number | null) => run({ listings: { 111: [L(RAW, 10, 200), ...many(OUT, 400000, 6, 2)] },
      items: [item(RAW, 'Raw', 1), item(OUT, 'Out', 1000)],
      recipes: [recipe(77, 'Out', OUT, [[RAW, 1]], { cooldownMs, cooldownCategory: cooldownMs ? 5 : null })],
      demand: { 111: { [OUT]: sells(48, 400000, { lowPerDay: 48, newPerDay: 0 }) } } });
    const plain = base(null);
    const v = plain.flips.find(x => x.family === 'craft_vendor')!;
    expect(v.notes).toContain('sells for 40g on the Alliance auction house');
    const cd = base(24 * HOUR);
    expect(cd.flips.find(x => x.family === 'craft_vendor')).toBeUndefined();
    expect(cd.heldBack.find(h => h.family === 'craft_vendor')).toMatchObject({ code: 'auction pays more' });
    expect(cd.flips.find(x => x.family === 'craft_auction')).toBeDefined();
  });
});

describe('L1: unknown stack size', () => {
  it('is treated as one per listing for effort', () => {
    const one = evalKey(inputsOf(ceruleanAtBens({ extra: { } })), DYE_KEY).e.at(10).minutes;
    const f = ceruleanAtBens();
    f.items = f.items.map(i => (i.id === DYE ? { ...i, stackSize: null } : i));
    const unknown = evalKey(inputsOf(f), DYE_KEY).e.at(10).minutes;
    // posting 10 that do not stack: 9 extra posts at 0.1 minutes each
    expect(unknown).toBeCloseTo(one + 0.9, 6);
  });
});

describe('the best amount is the most expected profit whose risk is not high (round 5)', () => {
  it('every larger profit on the table is high risk, and the most row shows it', () => {
    const { e } = evalKey(inputsOf(ceruleanAtBens()), DYE_KEY);
    const best = e.best!;
    expect(best.risk.level).not.toBe('high');
    for (let n = 1; n <= e.maxN; n++) {
      const o = e.at(n);
      if (o.expectedProfit > best.expectedProfit) expect(o.risk.level).toBe('high');
    }
    const most = e.options.find(o => o.label === 'most')!;
    expect(most.units).toBeGreaterThan(best.units);
    expect(most.note).toBe('most profit, higher risk');
    // the list ranks on the best amount, not the most
    const f = run(ceruleanAtBens()).flips.find(x => x.key === DYE_KEY)!;
    expect(f.score).toBe(f.best.expectedProfit);
  });
});

describe('independent sale counting test: the cautious estimate and the overnight queue', () => {
  it('finding 1: with 4 publishes sale counting has no low estimate, so none is derived and the flip waits as learning', () => {
    const d = openDb(tempDir(), ':memory:');
    const ORE = 2770, BAR = 2840;
    d.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES (111, 'Alliance Auction House', 'alliance', 0.05, 1, 0);
      INSERT INTO items (id, name, quality, sell_price, status, fetched_at, data_source) VALUES (${ORE}, 'Copper Ore', 'COMMON', 5, 200, 0, 'forever'), (${BAR}, 'Copper Bar', 'COMMON', 10, 200, 0, 'forever');
      INSERT INTO recipes (id, name, profession, crafted_item_id, qty_min, qty_max, learn_skill, spell_id) VALUES (2657, 'Smelt Copper', 'Mining', ${BAR}, 1, 1, 1, 2657);
      INSERT INTO recipe_reagents VALUES (2657, ${ORE}, 1);`);
    for (let h = 0; h < 4; h++) {
      const t = h * HOUR;
      for (const kind of ['auctions', 'commodities']) {
        const id = Number(d.prepare('INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, diff_hours) VALUES (111, ?, ?, ?, ?, 0, 0, 0, ?)')
          .run(kind, `${kind}${t}`, t, t, h ? 1 : null).lastInsertRowid);
        // Copper Bar: 2,000 units gone an hour in 20 listings, near the floor, a sold price recorded
        if (kind === 'commodities') d.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder,
          gone_listings, gone_units, gone_units_expiring, gone_units_near_floor, new_units, gone_units_expiring_near_floor, sold_value) VALUES (?, 111, ${BAR}, ?, 100, 1, 1, 1, 1, '[]', ?, ?, 0, ?, 0, 0, ?)`)
          .run(id, t, h ? 20 : null, h ? 2000 : null, h ? 2000 : null, h ? 200000 : null);
      }
    }
    const inputs = buildFlipInputs(d, new Map([[111, [L(ORE, 10, 5000), ...many(BAR, 100, 10, 200)]]]), 3 * HOUR);
    const dm = inputs.demand.get(111)!.get(BAR)!;
    expect(dm.hoursWatched).toBe(3);
    expect(dm.lowPerDay ?? null).toBeNull();
    const q = new SellBook(inputs).quote(inputs.houses[0]!, BAR)!;
    expect(q.salesPerDayLow).toBeNull();
    const res = runFlips(inputs);
    expect(res.flips.find(f => f.itemId === BAR && f.sellHouseId != null)).toBeUndefined();
    expect(res.heldBack.find(h => h.itemId === BAR && h.family === 'craft_auction')).toMatchObject({ code: 'learning' });
    // the same with 12 hours watched but no low estimate from sale counting: still learning, never derived here
    const r2 = run(ceruleanAtBens({ dyeDemand: { lowPerDay: null, saleEvents: 40, unitsPerEvent: 1, hoursWatched: 12, hours: 12 } }));
    expect(r2.heldBack.find(h => h.key === DYE_KEY)).toMatchObject({ code: 'learning', reason: 'learning: sale counting has no cautious sales estimate for it yet' });
  });
  it('finding 2: with an hourly mean and spread, overnight sales are normal, not one Poisson event an hour', () => {
    // Copper Ore pattern: about 2,000 units an hour in one run, sd 600 an hour; 15,000 ahead; 10 hour night: mean 20,000
    const base = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { newPerDay: 0 } }))).quote(A, DYE)!;
    // the low estimate is at the hourly mean here (48,000 a day), so the night's mean is the hourly mean's
    const normal = overnightQueue({ ...base, newPerHour: 0, salesPerDayLow: 48000, hourlyMean: 2000, hourlySd: 600, hourlyHours: 12 }, 10);
    // sd over the night = sqrt(10) x 600 = 1,897; position 15,001: z = (15000.5 - 20000) / 1897 = -2.64, near certain
    expect(normal.at(15001)).toBeCloseTo(1 - normalCdf((15000.5 - 20000) / (Math.sqrt(10) * 600)), 12);
    expect(normal.at(15001)).toBeGreaterThan(0.99);
    expect(normal.at(20000)).toBeCloseTo(0.5, 2);
    expect(normal.lastPos).toBe(Math.floor(20000 + 3.1 * Math.sqrt(10) * 600 + 0.5));
    // competing new posts come off the mean; never under 0
    expect(overnightQueue({ ...base, newPerHour: 2500, salesPerDayLow: 48000, hourlyMean: 2000, hourlySd: 600, hourlyHours: 12 }, 10).at(1)).toBe(0);
    // round 6 finding 1: a low estimate under the hourly mean sets the night's mean (24,000 a day: 10,000 a night)
    expect(overnightQueue({ ...base, newPerHour: 0, salesPerDayLow: 24000, hourlyMean: 2000, hourlySd: 600, hourlyHours: 12 }, 10).at(10000)).toBeCloseTo(0.5, 2);
    // the event model, with one event an hour of 2,000 units, reads the same queue as a coin toss
    const events = overnightQueue({ ...base, newPerHour: 0, salesPerDayLow: 48000, salesPerDayMid: 96000, unitsPerEvent: 2000, hourlyMean: null, hourlySd: null }, 10);
    expect(events.at(15001)).toBeLessThan(0.9);
    // under 6 hours of hourly figures the event model is used
    const short = overnightQueue({ ...base, newPerHour: 0, salesPerDayLow: 48000, salesPerDayMid: 96000, unitsPerEvent: 2000, hourlyMean: 2000, hourlySd: 600, hourlyHours: 4 }, 10);
    expect(short.at(15001)).toBe(events.at(15001));
    // normal cdf sanity
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
  });
});
