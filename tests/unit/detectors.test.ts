import { describe, it, expect } from 'vitest';
import { vendorDump } from '../../src/detectors/vendorDump.ts';
import { vendorSupply } from '../../src/detectors/vendorSupply.ts';
import { crossHouse } from '../../src/detectors/crossHouse.ts';
import { underpriced } from '../../src/detectors/underpriced.ts';
import type { DetectorContext, HouseCtx } from '../../src/detectors/types.ts';
import type { Listing } from '../../src/analysis/aggregate.ts';

const A: HouseCtx = { id: 110, name: 'Alliance Auction House', faction: 'alliance', cut: 0.05, pinned: true, publishedAt: 1 };
const B: HouseCtx = { id: 116, name: 'Blackwater Auction House', faction: 'blackwater', cut: 0.15, pinned: true, publishedAt: 1 };
let nid = 1;
const L = (itemId: number, unitPrice: number, quantity = 1): Listing => ({ id: nid++, itemId, quantity, unitPrice, timeLeft: 'LONG' });

function ctx(over: Partial<DetectorContext>): DetectorContext {
  return { houses: [A, B], listings: new Map(), items: new Map(), vendors: new Map(), demand: new Map(), now: 1, ...over };
}

describe('O1 vendor dump', () => {
  it('sums (vendor price minus listing price) times units, for listings under the line only', () => {
    const c = ctx({
      listings: new Map([[110, [L(2589, 10, 20), L(2589, 12, 14), L(2589, 13, 50), L(2589, 30, 5)]]]),
      items: new Map([[2589, { id: 2589, name: 'Linen Cloth', sellPrice: 13, binding: null, quality: 'COMMON' }]]),
    });
    const p = vendorDump(c);
    expect(p).toHaveLength(1);
    // (13-10)*20 + (13-12)*14 = 74
    expect(p[0]!.profit).toBe(74);
    expect(p[0]!.detail.units).toBe(34);
    expect(p[0]!.confidence).toBe('high');
    expect(p[0]!.summary).toMatch(/34 Linen Cloth/);
  });
  it('finds nothing when the floor is at or above the vendor price', () => {
    const c = ctx({ listings: new Map([[110, [L(2589, 13, 20)]]]), items: new Map([[2589, { id: 2589, name: 'Linen Cloth', sellPrice: 13, binding: null, quality: null }]]) });
    expect(vendorDump(c)).toHaveLength(0);
  });
});

describe('O2 vendor supply', () => {
  const items = new Map([[6532, { id: 6532, name: 'Bright Baubles', sellPrice: 62, binding: null, quality: 'COMMON' }]]);
  const vendors = new Map([[6532, [{ npcId: 2663, npcName: 'Old Man Heming', faction: 'neutral', zone: 'Stranglethorn Vale', x: 27.5, y: 77.1, unitPrice: 250, limited: false }]]]);
  it('Bright Baubles at 4s 80c on the Alliance house nets about 2s 6c each before demand is known', () => {
    const p = vendorSupply(ctx({ houses: [A], listings: new Map([[110, [L(6532, 480, 5)]]]), items, vendors }));
    expect(p).toHaveLength(1);
    // floor(480*0.95)=456, deposit floor(62*0.15)=9, 456-9-250 = 197
    expect(p[0]!.detail.gainPerUnit).toBe(197);
    expect(p[0]!.profit).toBe(197);
    expect(p[0]!.confidence).toBe('low');
  });
  it('scales by daily demand once known', () => {
    const demand = new Map([[110, new Map([[6532, { unitsPerDay: 40, hours: 12, snapshots: 12 }]])]]);
    const p = vendorSupply(ctx({ houses: [A], listings: new Map([[110, [L(6532, 480, 5)]]]), items, vendors, demand }));
    expect(p[0]!.profit).toBe(197 * 40);
    expect(p[0]!.confidence).toBe('medium');
  });
  it('ignores a thin gain', () => {
    expect(vendorSupply(ctx({ houses: [A], listings: new Map([[110, [L(6532, 280, 5)]]]), items, vendors }))).toHaveLength(0);
  });
});

describe('O7 cross house', () => {
  const items = new Map([[2592, { id: 2592, name: 'Wool Cloth', sellPrice: 33, binding: null, quality: 'COMMON' }]]);
  it('buys on Alliance under the Blackwater break even', () => {
    const p = crossHouse(ctx({
      listings: new Map([[110, [L(2592, 100, 20), L(2592, 125, 20)]], [116, [L(2592, 160, 10)]]]),
      items,
    }));
    const ab = p.find(x => x.detail.sellHouse === 116)!;
    // net on Blackwater: floor(160*0.85)=136 - deposit floor(33*0.15)=4 *5 = 20 -> 116
    expect(ab.detail.netPerUnit).toBe(116);
    // 100 clears (gain 16 >= 10% of 100), 125 does not
    expect(ab.profit).toBe(16 * 20);
  });
  it('does nothing until both houses are pinned', () => {
    expect(crossHouse(ctx({ houses: [A, { ...B, pinned: false }] }))).toHaveLength(0);
  });
});

describe('O3 underpriced', () => {
  const items = new Map([[2770, { id: 2770, name: 'Copper Ore', sellPrice: 5, binding: null, quality: null }]]);
  it('fires 40 percent under a typical floor on an item that sells', () => {
    const typical = new Map([[110, new Map([[2770, { typicalFloor: 150, readings: 30 }]])]]);
    const demand = new Map([[110, new Map([[2770, { unitsPerDay: 100, hours: 30, snapshots: 30 }]])]]);
    const p = underpriced(ctx({ houses: [A], listings: new Map([[110, [L(2770, 90, 10), L(2770, 150, 50)]]]), items, demand }), typical);
    expect(p).toHaveLength(1);
    // net at 150: floor(142.5)=142 - deposit max(1, floor(0.75))=1 -> 141; (141-90)*10
    expect(p[0]!.profit).toBe(510);
  });
  it('stays quiet without typical floor history', () => {
    expect(underpriced(ctx({ houses: [A], listings: new Map([[110, [L(2770, 90, 10)]]]), items }), new Map())).toHaveLength(0);
  });
});
