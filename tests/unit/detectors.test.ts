import { describe, it, expect } from 'vitest';
import { vendorDump } from '../../src/detectors/vendorDump.ts';
import { vendorSupply } from '../../src/detectors/vendorSupply.ts';
import { crossHouse } from '../../src/detectors/crossHouse.ts';
import { underpriced } from '../../src/detectors/underpriced.ts';
import { realisticUnits, type DetectorContext, type HouseCtx } from '../../src/detectors/types.ts';
import type { Listing } from '../../src/analysis/aggregate.ts';

const A: HouseCtx = { id: 111, name: 'Alliance Auction House', faction: 'alliance', cut: 0.05, pinned: true, publishedAt: 1 };
const B: HouseCtx = { id: 116, name: 'Blackwater Auction House', faction: 'blackwater', cut: 0.15, pinned: true, publishedAt: 1 };
let nid = 1;
const L = (itemId: number, unitPrice: number, quantity = 1): Listing => ({ id: nid++, itemId, quantity, unitPrice, timeLeft: 'LONG' });
const ctx = (over: Partial<DetectorContext>): DetectorContext => ({ houses: [A, B], listings: new Map(), items: new Map(), vendors: new Map(), demand: new Map(), now: 1, ...over });
const demandOf = (house: number, item: number, unitsPerDay: number) => new Map([[house, new Map([[item, { unitsPerDay, hours: 12, snapshots: 12 }]])]]);

describe('realistic units: Chip\'s share of daily sales', () => {
  it('20 percent of daily sales, at least 1, never more than available', () => {
    expect(realisticUnits(Infinity, 1000)).toBe(200);
    expect(realisticUnits(Infinity, 5)).toBe(1);
    expect(realisticUnits(50, 1000)).toBe(50);
    expect(realisticUnits(Infinity, null)).toBe(1);
  });
});

describe('O1 auction house to vendor', () => {
  it('profit per item is the average gain on every unit under the vendor price, all units count', () => {
    const c = ctx({ listings: new Map([[111, [L(2589, 10, 20), L(2589, 12, 14), L(2589, 13, 50)]]]),
      items: new Map([[2589, { id: 2589, name: 'Linen Cloth', sellPrice: 13, binding: null, quality: 'COMMON' }]]) });
    const p = vendorDump(c)[0]!;
    // (3*20 + 1*14) = 74 over 34 units
    expect(p.profit).toBe(74);
    expect(p.detail.perItem).toBe(2);
    expect(p.detail.buy).toMatchObject({ kind: 'auction', price: 11 });
    expect(p.detail.buy.places[0]!.zone).toBe('Stormwind City');
    expect(p.detail.sell).toMatchObject({ kind: 'any_vendor', price: 13 });
    expect(p.detail.realisticUnits).toBe(34);
  });
});

describe('O2 vendor to auction house', () => {
  const items = new Map([[6532, { id: 6532, name: 'Bright Baubles', sellPrice: 62, binding: null, quality: 'COMMON' }]]);
  const vendors = new Map([[6532, [{ npcId: 2663, npcName: 'Old Man Heming', faction: 'neutral', zone: 'Stranglethorn Vale', x: 27.5, y: 77.1, uiMap: 1434, unitPrice: 250, limited: false, minStanding: 4 }]]]);
  it('Bright Baubles at 4s 80c: 2s 6c profit each (456 after the 5% cut, minus 250)', () => {
    const p = vendorSupply(ctx({ houses: [A], listings: new Map([[111, [L(6532, 480, 5)]]]), items, vendors }))[0]!;
    expect(p.detail.perItem).toBe(206);
    expect(p.detail.buy).toMatchObject({ kind: 'vendor', who: 'Old Man Heming', price: 250 });
    expect(p.detail.buy.places[0]).toMatchObject({ uiMap: 1434, x: 27.5, y: 77.1 });
    expect(p.detail.sell).toMatchObject({ kind: 'auction', price: 456 });
    expect(p.detail.salesPerDay).toBeNull();
    expect(p.confidence).toBe('low');
  });
  it('40 sales a day at a 20 percent share: 8 realistic units, ranked by 206 x 8', () => {
    const p = vendorSupply(ctx({ houses: [A], listings: new Map([[111, [L(6532, 480, 5)]]]), items, vendors, demand: demandOf(111, 6532, 40) }))[0]!;
    expect(p.detail.realisticUnits).toBe(8);
    expect(p.profit).toBe(206 * 8);
    expect(p.detail.listing?.best).toBeDefined();
  });
  it('limited stock counts one purchase; a thin gain is ignored', () => {
    const lim = new Map([[6532, [{ ...vendors.get(6532)![0]!, limited: true }]]]);
    expect(vendorSupply(ctx({ houses: [A], listings: new Map([[111, [L(6532, 480, 5)]]]), items, vendors: lim, demand: demandOf(111, 6532, 40) }))[0]!.detail.realisticUnits).toBe(1);
    expect(vendorSupply(ctx({ houses: [A], listings: new Map([[111, [L(6532, 270, 5)]]]), items, vendors }))).toHaveLength(0);
  });
});

describe('O7 between houses', () => {
  const items = new Map([[2592, { id: 2592, name: 'Wool Cloth', sellPrice: 33, binding: null, quality: 'COMMON' }]]);
  it('buys on Alliance under the Blackwater break even, capped at 20% of Blackwater sales', () => {
    const p = crossHouse(ctx({ listings: new Map([[111, [L(2592, 100, 20), L(2592, 125, 20)]], [116, [L(2592, 160, 10)]]]), items, demand: demandOf(116, 2592, 50) }))
      .find(x => x.detail.sellHouse === 116)!;
    // net on Blackwater: floor(160 * 0.85) = 136. 100 clears, 125 does not. 20% of 50 = 10 units at 100.
    expect(p.detail.sell.price).toBe(136);
    expect(p.detail.available).toBe(20);
    expect(p.detail.realisticUnits).toBe(10);
    expect(p.detail.perItem).toBe(36);
    expect(p.profit).toBe(360);
    expect(p.detail.buy.places[0]!.zone).toBe('Stormwind City');
    expect(p.detail.sell.places[0]!.zone).toBe('Stranglethorn Vale');
  });
  it('does nothing until both houses are pinned', () => {
    expect(crossHouse(ctx({ houses: [A, { ...B, pinned: false }] }))).toHaveLength(0);
  });
});

describe('O3 cheap listing', () => {
  const items = new Map([[2770, { id: 2770, name: 'Copper Ore', sellPrice: 5, binding: null, quality: null }]]);
  it('fires 40 percent under a typical floor on an item that sells', () => {
    const typical = new Map([[111, new Map([[2770, { typicalFloor: 150, readings: 30 }]])]]);
    const p = underpriced(ctx({ houses: [A], listings: new Map([[111, [L(2770, 90, 10), L(2770, 150, 50)]]]), items, demand: demandOf(111, 2770, 100) }), typical)[0]!;
    // 20% of 100 = 20, capped at 10 cheap. net at 150 = 142, minus 90 = 52 each
    expect(p.detail.perItem).toBe(52);
    expect(p.profit).toBe(520);
  });
  it('stays quiet without typical floor history', () => {
    expect(underpriced(ctx({ houses: [A], listings: new Map([[111, [L(2770, 90, 10)]]]), items }), new Map())).toHaveLength(0);
  });
});
