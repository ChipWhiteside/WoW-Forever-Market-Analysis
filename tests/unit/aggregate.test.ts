import { describe, it, expect } from 'vitest';
import { aggregate, fromAuctionRows, fromCommodityRows, expiryChance, listingHours, nextSeen, buysFirst, type Listing, type Seen } from '../../src/analysis/aggregate.ts';

const L = (id: number, itemId: number, quantity: number, unitPrice: number | null, timeLeft: Listing['timeLeft'] = 'LONG'): Listing =>
  ({ id, itemId, quantity, unitPrice, timeLeft });

describe('aggregate', () => {
  it('computes floor, depth and ladder per item from unit prices', () => {
    const s = aggregate([L(1, 2770, 20, 150), L(2, 2770, 5, 150), L(3, 2770, 10, 157), L(4, 2770, 1, 300), L(5, 2589, 34, 12)], null);
    const ore = s.find(x => x.itemId === 2770)!;
    expect(ore.floor).toBe(150);
    expect(ore.unitsAtFloor).toBe(25);
    expect(ore.unitsWithin5).toBe(35); // 157 <= 157.5
    expect(ore.totalUnits).toBe(36);
    expect(ore.listings).toBe(4);
    expect(ore.ladder).toEqual([[150, 25], [157, 10], [300, 1]]);
    expect(ore.goneUnits).toBeNull();
  });

  it('never lets a bid only listing set the floor', () => {
    const s = aggregate([L(1, 9, 1, null), L(2, 9, 1, 500)], null);
    expect(s[0]!.floor).toBe(500);
    expect(s[0]!.totalUnits).toBe(2);
  });

  it('differences by listing id, splitting likely expiries and near floor sales', () => {
    const prev = [L(1, 7, 10, 100), L(2, 7, 5, 105, 'SHORT'), L(3, 7, 3, 200), L(4, 8, 1, 50)];
    const cur = [L(3, 7, 3, 200), L(5, 7, 4, 99)];
    const s = aggregate(cur, prev);
    const a = s.find(x => x.itemId === 7)!;
    expect(a.goneListings).toBe(2);
    expect(a.goneUnits).toBe(15);
    expect(a.goneUnitsExpiring).toBe(5);
    expect(a.goneUnitsNearFloor).toBe(15); // 100 and 105 are within 10% of 100
    expect(a.newUnits).toBe(4);
    // Item 8 vanished entirely but still gets a row recording the disappearance.
    const b = s.find(x => x.itemId === 8)!;
    expect(b.floor).toBeNull();
    expect(b.goneUnits).toBe(1);
  });

  it('counts a partial buy of a stack as gone units, and subtracts only near floor expiries', () => {
    const prev = [L(1, 7, 20, 100), L(2, 7, 5, 500, 'SHORT')];
    const cur = [L(1, 7, 12, 100)];
    const a = aggregate(cur, prev)[0]!;
    expect(a.goneUnits).toBe(13);              // 8 bought from listing 1, 5 expired at 500
    expect(a.goneUnitsNearFloor).toBe(8);
    expect(a.goneUnitsExpiringNearFloor).toBe(0); // the 500 expiry is nowhere near the floor
  });

  it('same row count but different ids is churn, not stability (ledger failure 3)', () => {
    const prev = [L(1, 7, 1, 10), L(2, 7, 1, 10)];
    const cur = [L(3, 7, 1, 10), L(4, 7, 1, 10)];
    const a = aggregate(cur, prev)[0]!;
    expect(a.goneUnits).toBe(2);
    expect(a.newUnits).toBe(2);
  });

  it('maps real row shapes from the ledger', () => {
    const eq = fromAuctionRows([{ id: 101872354, item: { id: 4308 }, buyout: 698, quantity: 1, time_left: 'LONG' }, { id: 2, item: { id: 5 }, quantity: 1, time_left: 'SHORT' }]);
    expect(eq[0]!.unitPrice).toBe(698);
    expect(eq[1]!.unitPrice).toBeNull();
    const c = fromCommodityRows([{ id: 106851476, item: { id: 2456 }, quantity: 10, unit_price: 100, time_left: 'LONG' }]);
    expect(c[0]!.unitPrice).toBe(100);
  });
});

describe('telling sales from expiries, relists and cancels', () => {
  it('2 hour listings (MEDIUM) that vanish are expiries, not sales: the 48 a day Blacksmith Hammer', () => {
    const prev = [L(1, 5956, 1, 100, 'MEDIUM'), L(2, 5956, 1, 100, 'MEDIUM'), L(3, 5956, 1, 900000, 'VERY_LONG')];
    const cur = [L(4, 5956, 1, 100, 'MEDIUM'), L(5, 5956, 1, 100, 'MEDIUM'), L(3, 5956, 1, 900000, 'VERY_LONG')];
    const a = aggregate(cur, prev).find(x => x.itemId === 5956)!;
    expect(a.goneUnitsNearFloor).toBe(2);
    expect(a.goneUnitsExpiringNearFloor).toBe(2); // none of them counted as sold
    expect(a.soldValue).toBe(0);
  });
  it('a cancel and relist on a thin market is not a sale', () => {
    const a = aggregate([L(2, 7, 5, 105, 'VERY_LONG')], [L(1, 7, 5, 100, 'LONG')])[0]!;
    expect(a.goneUnitsNearFloor! - a.goneUnitsExpiringNearFloor!).toBe(0);
  });
  it('stackables: a stack that vanished while a cheaper one is still up was cancelled, never bought', () => {
    const prev = [L(1, 7, 20, 100, 'LONG'), L(2, 7, 20, 105, 'LONG')];
    const a = aggregate([L(1, 7, 20, 100, 'LONG')], prev, { commodity: true })[0]!;
    expect(a.soldValue).toBe(0);
  });
  it('equipment: the buyer picks, so a slightly pricier listing selling first still counts', () => {
    const prev = [L(1, 7, 1, 100, 'LONG'), L(2, 7, 1, 105, 'LONG')];
    const a = aggregate([L(1, 7, 1, 100, 'LONG')], prev)[0]!;
    expect(a.soldValue).toBe(105);
  });
  it('a real sale of the cheapest units counts, with its price', () => {
    const prev = [L(1, 7, 20, 100, 'LONG'), L(2, 7, 20, 100, 'LONG'), L(3, 7, 20, 104, 'LONG'), L(4, 7, 20, 104, 'LONG'), L(5, 7, 20, 104, 'LONG'), L(6, 7, 20, 104, 'LONG')];
    const cur = prev.slice(2);
    const a = aggregate(cur, prev)[0]!;
    expect(a.goneUnitsNearFloor! - a.goneUnitsExpiringNearFloor!).toBe(40);
    expect(a.soldValue).toBe(40 * 100);
  });
});

describe('listing age, buy order and sweeps (flip plan holes 11 and 12)', () => {
  const H = 3600_000;
  const t0 = Date.parse('2026-11-24T05:25:00Z');
  // A listing first seen at t0, posted after the publish an hour before (age known).
  const fresh = (tl: Listing['timeLeft']): Seen => ({ firstSeen: t0, firstTimeLeft: tl, postedAfter: t0 - H });

  it('reads the listing length from the time left when first seen: MEDIUM 2, LONG 8, VERY_LONG 24 hours', () => {
    expect(listingHours(fresh('MEDIUM'))).toBe(2);
    expect(listingHours(fresh('LONG'))).toBe(8);
    expect(listingHours(fresh('VERY_LONG'))).toBe(24);
    expect(listingHours({ firstSeen: t0, firstTimeLeft: 'LONG', postedAfter: null })).toBeNull(); // age unknown: 8 or an aged 24
    expect(listingHours({ firstSeen: t0, firstTimeLeft: 'VERY_LONG', postedAfter: null })).toBe(24); // only 24 hour listings show it
  });

  it('a 2 hour listing cannot expire in its first hour, can in its second', () => {
    const l = L(1, 7, 1, 100, 'MEDIUM');
    expect(expiryChance(l, fresh('MEDIUM'), t0, t0 + H).chance).toBe(0);
    expect(expiryChance({ ...l, timeLeft: 'SHORT' }, fresh('MEDIUM'), t0 + H, t0 + 2 * H).chance).toBe(1);
    // Unknown age falls back to the time left alone: MEDIUM (30 minutes to 2 hours) may run out within the hour.
    expect(expiryChance(l, undefined, t0, t0 + H).chance).toBeGreaterThan(0.05);
    expect(expiryChance(L(1, 7, 1, 100, 'LONG'), undefined, t0, t0 + H).chance).toBe(0);
  });

  it('the fastest movers count again: a fresh 2 hour listing that vanished within the hour was bought (old rule: expired)', () => {
    const prev = [L(1, 5956, 1, 100, 'MEDIUM'), L(2, 5956, 1, 100, 'MEDIUM'), L(3, 5956, 1, 150, 'VERY_LONG')];
    const cur = [L(3, 5956, 1, 150, 'VERY_LONG')];
    const seen = new Map([[1, fresh('MEDIUM')], [2, fresh('MEDIUM')], [3, fresh('VERY_LONG')]]);
    const a = aggregate(cur, prev, { prevAt: t0, curAt: t0 + H, seen })[0]!;
    expect(a.soldUnits).toBe(2);
    expect(a.soldValue).toBe(200);
    expect(a.goneUnitsExpiring).toBe(0);
    // Without ages (the old reading) the same two are treated as expiries.
    expect(aggregate(cur, prev, { prevAt: t0, curAt: t0 + H })[0]!.soldUnits).toBe(0);
  });

  it('the Blacksmith Hammer relists stay out: a 2 hour listing in its last hour that vanished and came back is not a sale', () => {
    const prev = [L(1, 5956, 1, 100, 'SHORT'), L(3, 5956, 1, 900000, 'VERY_LONG')];
    const cur = [L(4, 5956, 1, 100, 'MEDIUM'), L(3, 5956, 1, 900000, 'VERY_LONG')];
    const seen = new Map([[1, { firstSeen: t0 - H, firstTimeLeft: 'MEDIUM' as const, postedAfter: t0 - 2 * H }]]);
    const a = aggregate(cur, prev, { prevAt: t0, curAt: t0 + H, seen })[0]!;
    expect(a.soldUnits).toBe(0);
    expect(a.goneUnitsExpiring).toBe(1);
  });

  it('commodities: newest first at one price, so an older stack that vanished behind a survivor was not bought', () => {
    // All at 1c. The newest (id 30) was partly bought; 20 and 10 are older. 10 vanished: cancelled or expired.
    const prev = [L(10, 2512, 200, 1, 'SHORT'), L(20, 2512, 500, 1, 'LONG'), L(30, 2512, 100, 1, 'LONG')];
    const cur = [L(20, 2512, 500, 1, 'LONG'), L(30, 2512, 40, 1, 'LONG')];
    const a = aggregate(cur, prev, { commodity: true })[0]!;
    expect(a.soldUnits).toBe(60);
    expect(buysFirst(L(30, 1, 1, 1), L(20, 1, 1, 1))).toBe(true);
    expect(buysFirst(L(20, 1, 1, 1), L(30, 1, 1, 2))).toBe(true);
  });

  it('commodities: a sweep past 10 percent over the floor counts in full and records how high buyers paid', () => {
    const prev = [L(1, 2770, 20, 100), L(2, 2770, 20, 104), L(3, 2770, 20, 115), L(4, 2770, 20, 130), L(5, 2770, 20, 160)];
    const cur = [L(4, 2770, 5, 130), L(5, 2770, 20, 160)];
    const a = aggregate(cur, prev, { commodity: true })[0]!;
    expect(a.soldUnits).toBe(75);
    expect(a.soldEvents).toBe(4); // three stacks bought whole, one in part
    expect(a.sweepHigh).toBe(130);
    expect(a.soldValue).toBe(20 * 100 + 20 * 104 + 20 * 115 + 15 * 130);
    expect(a.goneUnitsNearFloor! - a.goneUnitsExpiringNearFloor!).toBe(40); // the old near floor count, kept
  });

  it('commodities: a stack that could have expired but sits ahead of a stack buyers reached was bought', () => {
    // Stack 1 shows MEDIUM (could run out this hour); buyers took all of it and part of stack 2.
    const prev = [L(1, 7, 10, 100, 'MEDIUM'), L(2, 7, 10, 101, 'LONG')];
    const a = aggregate([L(2, 7, 4, 101, 'LONG')], prev, { commodity: true })[0]!;
    expect(a.soldUnits).toBe(16);
    // A SHORT stack (under 30 minutes left) most likely ran out before a buyer came: it stays expired.
    const b = aggregate([L(2, 7, 4, 101, 'LONG')], [L(1, 7, 10, 100, 'SHORT'), L(2, 7, 10, 101, 'LONG')], { commodity: true })[0]!;
    expect(b.soldUnits).toBe(6);
  });

  it('deep equipment: a copy cancelled and posted cheaper under a copy already up is an undercut, not a sale', () => {
    const others = [10, 11, 12, 13, 14].map(id => L(id, 4251, 1, 1200, 'LONG'));
    const prev = [L(1, 4251, 1, 950, 'LONG'), L(2, 4251, 1, 1000, 'LONG'), ...others];
    const cur = [L(1, 4251, 1, 950, 'LONG'), L(9, 4251, 1, 940, 'LONG'), ...others];
    const a = aggregate(cur, prev)[0]!;
    expect(a.soldUnits).toBe(0);
    // Bought with nothing reposted under it: a sale.
    expect(aggregate([L(1, 4251, 1, 950, 'LONG'), ...others], prev)[0]!.soldUnits).toBe(1);
  });

  it('deep commodities: a same size stack posted cheaper is not taken as an undercut (pure coincidence there, B35)', () => {
    const deep = [10, 11, 12, 13, 14, 15].map(id => L(id, 2589, 20, 30, 'LONG'));
    const prev = [L(1, 2589, 20, 25, 'LONG'), ...deep];
    const cur = [L(9, 2589, 20, 24, 'LONG'), L(8, 2589, 5, 23, 'LONG'), ...deep];
    expect(aggregate(cur, prev, { commodity: true })[0]!.soldUnits).toBe(20);
  });

  it('counts new units posted at or under 1.1 times the floor, and leaves out the own trades hook', () => {
    const prev = [L(1, 7, 10, 100), L(2, 7, 10, 200)];
    const cur = [L(2, 7, 10, 200), L(3, 7, 5, 105), L(4, 7, 5, 111), L(5, 7, 7, 90)];
    const a = aggregate(cur, prev, { commodity: true, own: { listingIds: new Set([1, 5]) } })[0]!;
    expect(a.newNearFloor).toBe(5); // 105 counts, 111 is over, 90 is an own trade
    expect(a.soldUnits).toBe(0); // listing 1 was an own trade
    // Razor Arrow, seen live: the 1c stacks sold out and every new post sat at 2c, the new floor. Those compete.
    const r = aggregate([L(9, 3030, 50, 2, 'LONG'), L(8, 3030, 30, 3, 'LONG')], [L(1, 3030, 100, 1, 'LONG')], { commodity: true })[0]!;
    expect(r.newNearFloor).toBe(50);
  });

  it('sanity bound: units judged sold never exceed previous plus new minus current units; a breach is logged and capped', () => {
    // A stack that grew (impossible in game) makes the totals disagree with the per listing count.
    const diag = { ageConflicts: 0, breaches: [] as string[] };
    const a = aggregate([L(2, 7, 15, 100)], [L(1, 7, 10, 90), L(2, 7, 5, 100)], { commodity: true, diag })[0]!;
    expect(a.boundBreach).toBe(10);
    expect(a.soldUnits).toBe(0);
    expect(diag.breaches[0]).toMatch(/item 7: 10 judged sold, only 0 left/);
  });

  it('first sights carry over, new listings get this publish and its predecessor, unknown ones are seeded', () => {
    const prev = { listings: [L(1, 7, 1, 1, 'LONG')], at: t0 - H };
    const s = nextSeen(null, [L(1, 7, 1, 1, 'LONG'), L(2, 7, 1, 1, 'MEDIUM')], t0, prev, true);
    expect(s.get(1)).toEqual({ firstSeen: t0 - H, firstTimeLeft: 'LONG', postedAfter: null });
    expect(s.get(2)).toEqual({ firstSeen: t0, firstTimeLeft: 'MEDIUM', postedAfter: t0 - H });
    const s2 = nextSeen(s, [L(2, 7, 1, 1, 'SHORT')], t0 + H, { listings: [L(1, 7, 1, 1, 'LONG'), L(2, 7, 1, 1, 'MEDIUM')], at: t0 }, true);
    expect([...s2.keys()]).toEqual([2]);
    expect(s2.get(2)).toBe(s.get(2));
    // After a gap the age of a new listing is unknown.
    expect(nextSeen(null, [L(3, 7, 1, 1, 'LONG')], t0, prev, false).get(3)!.postedAfter).toBeNull();
  });
});
