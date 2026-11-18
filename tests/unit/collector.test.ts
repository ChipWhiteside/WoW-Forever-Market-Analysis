import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { Collector } from '../../src/engine/collector.ts';
import { fakeBlizzard, tempDir } from '../helpers.ts';

const house = { id: 110, name: 'Alliance Auction House', faction: 'alliance' as const, cut: 0.05, tracked: 1, pinned: 0 };

describe('collector', () => {
  it('stores a publish, ignores a 304, differences the next publish, and survives a restart', async () => {
    const dir = tempDir();
    let lm = 'Wed, 18 Nov 2026 04:25:16 GMT';
    let rows = [
      { id: 1, item: { id: 2770 }, quantity: 20, unit_price: 150, time_left: 'LONG' },
      { id: 2, item: { id: 2770 }, quantity: 5, unit_price: 160, time_left: 'SHORT' },
    ];
    const { client } = fakeBlizzard({
      '/data/wow/ruleset/2/auctions/110/commodities': () => ({ body: { _links: {}, auctions: rows }, lastModified: lm }),
    });
    const db = openDb(dir, ':memory:');
    const c = new Collector(client, db, dir);
    const first = await c.poll(house, 'commodities');
    expect(first?.rows).toBe(2);
    expect(first?.stats[0]?.floor).toBe(150);
    expect(first?.stats[0]?.goneUnits).toBeNull();

    expect(await c.poll(house, 'commodities')).toBeNull(); // 304

    lm = 'Wed, 18 Nov 2026 05:25:10 GMT';
    rows = [{ id: 1, item: { id: 2770 }, quantity: 20, unit_price: 150, time_left: 'LONG' }, { id: 3, item: { id: 2770 }, quantity: 7, unit_price: 149, time_left: 'VERY_LONG' }];
    const second = await c.poll(house, 'commodities');
    expect(second?.stats[0]?.goneUnits).toBe(5);
    expect(second?.stats[0]?.goneUnitsExpiring).toBe(5);
    expect(second?.stats[0]?.newUnits).toBe(7);
    expect(second?.stats[0]?.floor).toBe(149);

    // A fresh collector on the same database restores the cursor from the raw file.
    const c2 = new Collector(client, db, dir);
    expect(await c2.poll(house, 'commodities')).toBeNull();
    lm = 'Wed, 18 Nov 2026 06:25:00 GMT';
    rows = [{ id: 3, item: { id: 2770 }, quantity: 7, unit_price: 149, time_left: 'VERY_LONG' }];
    const third = await c2.poll(house, 'commodities');
    expect(third?.stats[0]?.goneUnits).toBe(20);
    const n = db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number };
    expect(n.n).toBe(3);
  });

  it('flags an empty house as a suspected bug instead of a market fact', async () => {
    const dir = tempDir();
    const { client } = fakeBlizzard({ '/data/wow/ruleset/2/auctions/112': () => ({ body: { id: 112, _links: {} }, lastModified: 'Wed, 18 Nov 2026 04:00:00 GMT' }) });
    const c = new Collector(client, openDb(dir, ':memory:'), dir);
    const ev = await c.poll({ ...house, id: 112 }, 'auctions');
    expect(ev?.suspect[0]).toMatch(/zero listings/);
  });

  it('rejects a payload that breaks the contract (commodities key as an array is fine, as a number is not)', async () => {
    const dir = tempDir();
    const { client } = fakeBlizzard({ '/data/wow/ruleset/2/auctions/110': () => ({ body: { id: 110, auctions: [{ id: 1, item: 4308, buyout: 1, quantity: 1, time_left: 'LONG' }] }, lastModified: 'x' }) });
    const c = new Collector(client, openDb(dir, ':memory:'), dir);
    await expect(c.poll(house, 'auctions')).rejects.toThrow(/Contract violation/);
  });
});
