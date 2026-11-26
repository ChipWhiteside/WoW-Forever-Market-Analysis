/**
 * Round 3 of independent testing (November 26, brief docs/handoff/brief-flip-r6.md). One test per finding.
 */
import { describe, it, expect } from 'vitest';
import { A, L, many, item, vendor, recipe, sells, inputsOf, evalKey, run, ceruleanAtBens, DYE, DYE_RECIPE } from './flips.fixture.ts';
import { SellBook, overnightQueue } from '../../src/flips/sellBook.ts';
import { evaluate, settle, coverShare, soldCurve, tomorrowCurve, badCaseNet } from '../../src/flips/evaluate.ts';
import { COOLDOWN_LEARNING, UNKNOWN_LEARN, UNKNOWN_TEACH_SOURCE, runFlips } from '../../src/flips/run.ts';
import { deposit } from '../../src/rules/fees.ts';
import { flipKey } from '../../src/flips/families.ts';

const DYE_KEY = `craft_auction:111:${DYE}:${DYE_RECIPE}`;
const HOUR = 3600_000;

describe('finding 1: the overnight queue runs on the low estimate, not the middle', () => {
  it('two repricing events read as 60 a day middle but 1.4 a day low sell 1.4 x 10/24 overnight', () => {
    const q = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { unitsPerDay: 60, lowPerDay: 1.4, newPerDay: 0 } }))).quote(A, DYE)!;
    expect(q.salesPerDayMid).toBe(60);
    expect(overnightQueue(q, 10).meanEvents).toBeCloseTo(1.4 * 10 / 24, 9);
    // the middle stays on the quote for the card's "about N a day"
    const mid = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { unitsPerDay: 60, lowPerDay: 60, newPerDay: 0 } }))).quote(A, DYE)!;
    expect(overnightQueue(mid, 10).meanEvents).toBeCloseTo(25, 9);
    // the same flip at a 1.4 a day low expects far less than at 60
    const thin = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { unitsPerDay: 60, lowPerDay: 1.4, newPerDay: 0 } })), DYE_KEY).e;
    const deep = evalKey(inputsOf(ceruleanAtBens({ dyeDemand: { unitsPerDay: 60, lowPerDay: 60, newPerDay: 0 } })), DYE_KEY).e;
    expect(thin.cap).toBeLessThan(1);
    expect(thin.best!.expectedProfit).toBeLessThan(deep.best!.expectedProfit / 5);
  });
});

describe('finding 2: a teaching item with no known source', () => {
  const PATTERN = 900601;
  const withPattern = (extra: { vendors?: boolean; listed?: boolean; loot?: boolean } = {}) => {
    const f = ceruleanAtBens();
    f.recipes = f.recipes!.map(r => ({ ...r, learnSource: 'item', teachItemId: PATTERN }));
    f.items = [...f.items, item(PATTERN, 'Pattern: Cerulean Dye', null, { binding: 'ON_ACQUIRE', bonding: 1, quality: 'EPIC' })];
    if (extra.vendors) f.vendors = { ...(f.vendors ?? {}), [PATTERN]: [vendor('Pattern Seller', 5000)] };
    if (extra.listed) f.listings = { ...f.listings, 111: [...f.listings[111]!, L(PATTERN, 90000)] };
    const inputs = inputsOf(f);
    if (extra.loot) inputs.lootItems = new Set([PATTERN]);
    return inputs;
  };
  it('the card says how to learn it is not known yet, and it is a risk driver (Felblood Soul Bag)', () => {
    const f = runFlips(withPattern()).flips.find(x => x.key === DYE_KEY)!;
    expect(f.setup).toMatchObject({ where: `${UNKNOWN_LEARN} (${UNKNOWN_TEACH_SOURCE})`, unknown: true, teachItem: { id: PATTERN } });
    expect(f.notes).toContain('how to learn it is not known yet (the recipe item has no known source)');
    expect(f.best.risk.drivers).toContain(UNKNOWN_LEARN);
  });
  it('a vendor, a listing or a drop is a known source', () => {
    for (const extra of [{ vendors: true }, { listed: true }, { loot: true }]) {
      const f = runFlips(withPattern(extra)).flips.find(x => x.key === DYE_KEY)!;
      expect(f.setup!.unknown).toBeFalsy();
      expect(f.best.risk.drivers).not.toContain(UNKNOWN_LEARN);
    }
    const dropped = runFlips(withPattern({ loot: true })).flips.find(x => x.key === DYE_KEY)!;
    expect(dropped.setup!.where).toBe('Pattern: Cerulean Dye (no seller seen)');
  });
});

describe('finding 3: a cooldown is not spent at a vendor while the auction path learns', () => {
  it('held back when the cheapest listing is over twice the vendor price (Refined Deeprock Salt)', () => {
    const RAW = 900700, SALT = 900701;
    const base = (hours: number, floor: number) => run({ listings: { 111: [L(RAW, 1, 200), ...many(SALT, floor, 170)] },
      items: [item(RAW, 'Deeprock Salt', 1), item(SALT, 'Refined Deeprock Salt', 1000)],
      recipes: [recipe(15409, 'Salt Shaker', SALT, [[RAW, 1]], { cooldownMs: 71 * HOUR, cooldownCategory: 9, kind: 'conversion' })],
      demand: { 111: { [SALT]: sells(48, floor, { lowPerDay: 48, newPerDay: 0, hours }) } } });
    const learning = base(4, 380000);
    expect(learning.flips.find(x => x.family !== 'craft_auction' && x.itemId === SALT)).toBeUndefined();
    expect(learning.heldBack.find(h => h.itemId === SALT && h.sellHouseId == null)).toMatchObject({ code: 'auction likely pays more', reason: COOLDOWN_LEARNING });
    // a floor under twice the vendor price: the vendor path stays
    expect(base(4, 1900).flips.find(x => x.itemId === SALT && x.sellHouseId == null)).toBeDefined();
  });
});

describe('low findings', () => {
  it('a vendor sale whose very first step fails the margin is held back as too thin', () => {
    const LINEN = 2589;
    // 1g vendor price, 5s margin: a 96s first listing fails, the cheaper ones behind it are never reached
    const fx = { listings: { 111: [L(LINEN, 9600, 1), L(LINEN, 9700, 1), L(LINEN, 9800, 1)] }, items: [item(LINEN, 'Big Thing', 10000, { dataSource: 'forever' })] };
    // the walk keeps the first step alone (it used to keep every step when the first failed)
    expect(evalKey(inputsOf(fx), flipKey('auction_vendor', null, LINEN)).e.walk.steps).toHaveLength(1);
    expect(run(fx).heldBack.find(h => h.family === 'auction_vendor')).toMatchObject({ code: 'vendor margin too thin' });
  });
  it('the small row stays inside one crafting session', () => {
    // 10 minute casts in a 30 minute session: 3 crafts fit, so the small row is 3, never past the most row
    const f = ceruleanAtBens();
    f.recipes = f.recipes!.map(r => ({ ...r, castMs: 10 * 60_000 }));
    const e = evalKey(inputsOf(f), DYE_KEY).e;
    const small = e.options.find(o => o.label === 'small')!, most = e.options.find(o => o.label === 'most')!;
    expect(small.units).toBe(3);
    expect(small.units).toBeLessThanOrEqual(most.units);
  });
  it('tomorrow\'s bad case clears the units ahead at the bad case rate', () => {
    // 30 ahead of Chip (taken by flips ranked above, capUsed) and 20 sale events expected tonight: the expected case
    //   leaves 10 ahead tomorrow, the bad case (half of tonight's sales) 20
    const inputs = inputsOf(ceruleanAtBens({ dyeDemand: { lowPerDay: 60, newPerDay: 12 } }));
    const { c, market, e: first } = evalKey(inputs, DYE_KEY);
    market.rollback(first.walk.startMark);
    const e = evaluate(c, market, inputs, new Map(inputs.recipes.map(r => [r.id, r])), { capUsed: 30, gold: null, timeRate: 0, horizonHours: 10 });
    const q = c.quote;
    const n = 10, o = e.at(n);
    const queue = overnightQueue(q, 10), queue24 = overnightQueue(q, 24);
    const tonight = soldCurve(q, queue, 30, 5000).soldAt(n);
    const dep = deposit('alliance', 75, 1, 24);
    const loss = (ahead: number) => Math.max(0, Math.round(o.cost - settle(n, tonight, tomorrowCurve(queue24, ahead, 5000), badCaseNet(c, q), 75, dep, 0.5, 0.5, true, 14 / 24).value));
    const cleared = queue.meanEvents * queue.unitsPerEvent;
    expect(cleared).toBeCloseTo(20, 9);
    expect(loss(30 - cleared / 2)).toBeGreaterThan(loss(30 - cleared));
    expect(o.risk.badCaseLoss).toBe(loss(30 - cleared / 2));
  });
  it('no second deposit while tonight\'s 24 hour listing is still up', () => {
    // 10 hour night: the listing covers 14 of tomorrow's 24 hours
    expect(coverShare(10)).toBeCloseTo(14 / 24, 12);
    expect(coverShare(30)).toBe(0);
    const three = (left: number) => Math.min(left, 3);
    // 10 posted, 6 sold tonight at 100, 3 tomorrow, 20c deposit, 10c vendor: 3 x 14/24 = 1.75 sold before the listing
    //   expires; relist: 900 - (4 - 1.75) x 20 - 1 x 20 + 1 x 10 = 845 (was 810 with every unsold unit relisted)
    expect(settle(10, 6, three, 100, 10, 20, 1, 1, true, 14 / 24).value).toBeCloseTo(845, 9);
    // a listing that covers all of tomorrow: one deposit lost on what is still unsold
    expect(settle(10, 6, three, 100, 10, 20, 1, 1, true, 1).value).toBe(900 - 10);
  });
});
