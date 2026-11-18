import { describe, it, expect } from 'vitest';
import { aggregate, fromAuctionRows, fromCommodityRows, type Listing } from '../../src/analysis/aggregate.ts';

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
