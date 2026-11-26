/**
 * Whole system review, round 1 (November 26, brief docs/handoff/brief-system-r1-fixes.md). One test per engine finding.
 */
import { describe, it, expect } from 'vitest';
import { A, L, many, item, recipe, sells, inputsOf, run, ceruleanAtBens, DYE, DYE_RECIPE } from './flips.fixture.ts';
import { Market, type TraceEntry } from '../../src/flips/market.ts';
import { SellBook } from '../../src/flips/sellBook.ts';
import { COOLDOWN_OPPORTUNITY } from '../../src/flips/evaluate.ts';
import { HORDE_ONLY, HORDE_ONLY_DRIVER, UNKNOWN_LEARN, UNKNOWN_TEACH_SOURCE } from '../../src/flips/run.ts';

const HOUR = 3600_000;
const DYE_KEY = `craft_auction:111:${DYE}:${DYE_RECIPE}`;

describe('J3: a cooldown sub craft costs at least its product\'s auction net', () => {
  const RAW = 900800, SALT = 900801, HIDE = 900802;
  const salt = recipe(15409, 'Refined Deeprock Salt', SALT, [[RAW, 1]], { cooldownMs: 71 * HOUR, cooldownCategory: 9, kind: 'conversion' });
  const hide = recipe(19047, 'Cured Rugged Hide', HIDE, [[SALT, 1]]);
  const fixture = () => ({ listings: { 111: [L(RAW, 350, 50), ...many(SALT, 380000, 170)] },
    items: [item(RAW, 'Deeprock Salt', 1, { dataSource: 'forever' }), item(SALT, 'Refined Deeprock Salt', 1000, { dataSource: 'forever' }), item(HIDE, 'Cured Rugged Hide', 5000, { dataSource: 'forever' })],
    recipes: [salt, hide], demand: { 111: { [SALT]: sells(48, 380000, { lowPerDay: 48, newPerDay: 0, hours: 24 }) } } });

  it('the cost book charges the salt at its auction net, not the 3s 50c of raw salt', () => {
    const inputs = inputsOf(fixture());
    const book = new SellBook(inputs);
    const net = book.quote(A, SALT)!.netEach;
    const mode = { houses: [111], vendor: true, craft: true };
    const plain = new Market(inputs, inputs.recipes);
    expect(plain.takeOne(SALT, mode, new Set(), 1, null)).toBe(350);
    const m = new Market(inputs, inputs.recipes);
    m.opportunityOf = id => book.quote(A, id)?.netEach ?? null;
    const trace: TraceEntry[] = [];
    expect(m.takeOne(SALT, mode, new Set(), 1, trace)).toBe(net);
    const step = trace.find(t => t.source === 'craft')!;
    expect(step.cost).toBe(net);
    expect(step.opportunity).toBe(net - 350);
    // a recipe with no cooldown is never floored
    expect(m.cooldownFloor(hide)).toBe(0);
  });

  it('a vendor craft that would burn the cooldown for a few silver no longer ranks (Cured Rugged Hide)', () => {
    const r = run(fixture());
    expect(r.flips.find(f => f.itemId === HIDE)).toBeUndefined();
    expect(r.heldBack.find(h => h.itemId === HIDE && h.sellHouseId == null)?.code).toBe('no profit at the vendor price');
  });

  it('the cooldown is still free when its product is not listed anywhere', () => {
    const f = fixture();
    f.listings = { 111: [L(RAW, 350, 50)] };
    f.demand = { 111: {} } as never;
    const hideFlip = run(f).flips.find(x => x.itemId === HIDE && x.sellHouseId == null)!;
    expect(hideFlip).toBeDefined();
    expect(hideFlip.buy.some(l => l.note === COOLDOWN_OPPORTUNITY)).toBe(false);
  });
});

describe('J2 and J1: learnability risk', () => {
  it('a teaching item with no known source makes the flip high risk (Felblood Soul Bag)', () => {
    const PATTERN = 900601;
    const f = ceruleanAtBens();
    f.recipes = f.recipes!.map(r => ({ ...r, learnSource: 'item', teachItemId: PATTERN }));
    f.items = [...f.items, item(PATTERN, 'Pattern: Cerulean Dye', null, { binding: 'ON_ACQUIRE', bonding: 1, quality: 'EPIC' })];
    const flip = run(f).flips.find(x => x.key === DYE_KEY)!;
    expect(flip.setup).toMatchObject({ where: `${UNKNOWN_LEARN} (${UNKNOWN_TEACH_SOURCE})`, unknown: true });
    expect(flip.best.risk.level).toBe('high');
    expect(flip.options.every(o => o.risk.level === 'high')).toBe(true);
  });

  it('Horde trainers only is a risk driver and leaves the level alone', () => {
    const base = run(ceruleanAtBens()).flips.find(x => x.key === DYE_KEY)!;
    const f = ceruleanAtBens();
    f.recipes = f.recipes!.map(r => ({ ...r, learnSource: 'trainer_horde_only', learnSkill: 200 }));
    const flip = run(f).flips.find(x => x.key === DYE_KEY)!;
    expect(flip.setup!.where).toBe(HORDE_ONLY);
    expect(flip.best.risk.drivers).toContain(HORDE_ONLY_DRIVER);
    expect(flip.best.risk.level).toBe(base.best.risk.level);
    expect(base.best.risk.drivers).not.toContain(HORDE_ONLY_DRIVER);
  });
});

describe('the price just jumped only when the floor rose (coordinator item 7)', () => {
  const at = (floorChange1h: number | null) => run(ceruleanAtBens({ dye: [L(DYE, 9000, 5), L(DYE, 9001, 5), L(DYE, 9050, 5)],
    dyeDemand: { soldPrice: 7550, recentSoldPrice: 7550, sweepHigh: 9000, floorChange1h } })).flips.find(f => f.key === DYE_KEY)!;
  it('a sweep above the claim with a still floor is said as it is', () => {
    const f = at(0);
    expect(f.best.risk.drivers).not.toContain('the price just jumped');
    expect(f.best.risk.drivers).toContain('buyers paid up to 90s this hour, above the price used');
  });
  it('a floor up over 10 percent this hour is a jump', () => {
    expect(at(0.15).best.risk.drivers).toContain('the price just jumped');
    expect(at(0.05).best.risk.drivers).not.toContain('the price just jumped');
  });
});
