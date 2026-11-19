import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { Collector } from '../../src/engine/collector.ts';
import { demandByItem } from '../../src/analysis/history.ts';
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
    // The cheapest stack (7 at 149) sells; stackables always fill from the cheapest listing first.
    rows = [{ id: 1, item: { id: 2770 }, quantity: 20, unit_price: 150, time_left: 'LONG' }];
    const third = await c2.poll(house, 'commodities');
    expect(third?.stats[0]?.goneUnits).toBe(7);
    // Two differenced hours. Sales: 7 at 149 in hour 2 (the 5 SHORT units at 160 expired in hour 1, not sold).
    const d = demandByItem(db, 110, { now: Date.parse('Wed, 18 Nov 2026 06:30:00 GMT') }).get(2770)!;
    expect(d.hours).toBe(2);
    expect(d.unitsPerDay).toBeCloseTo(84, -1);
    expect(d.soldPrice).toBe(149);
    const n = db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number };
    expect(n.n).toBe(3);

    // The engine was off for two days: never difference across the gap, it would fake two days of sales as one hour.
    lm = 'Fri, 20 Nov 2026 06:25:00 GMT';
    rows = [];
    const afterGap = await c2.poll(house, 'commodities');
    expect(afterGap?.stats).toHaveLength(0); // with differencing, item 2770 would show 20 gone units
    const hours = db.prepare('SELECT diff_hours h FROM snapshots ORDER BY published_at').all() as Array<{ h: number | null }>;
    expect(hours.map(r => r.h === null ? null : Math.round(r.h * 100) / 100)).toEqual([null, 1, 1, null]);
  });

  it('flags an empty house as a suspected bug instead of a market fact', async () => {
    const dir = tempDir();
    const { client } = fakeBlizzard({ '/data/wow/ruleset/2/auctions/112': () => ({ body: { id: 112, _links: {} }, lastModified: 'Wed, 18 Nov 2026 04:00:00 GMT' }) });
    const c = new Collector(client, openDb(dir, ':memory:'), dir);
    const ev = await c.poll({ ...house, id: 112 }, 'auctions');
    expect(ev?.suspect[0]).toMatch(/zero listings/);
  });

  it('a dead house that answers commodities with no auctions key is zero listings and a suspected bug (seen live)', async () => {
    const dir = tempDir();
    const { client } = fakeBlizzard({ '/data/wow/ruleset/2/auctions/112/commodities': () => ({ body: { _links: {} }, lastModified: 'Thu, 19 Nov 2026 04:00:00 GMT' }) });
    const c = new Collector(client, openDb(dir, ':memory:'), dir);
    const ev = await c.poll({ ...house, id: 112 }, 'commodities');
    expect(ev?.rows).toBe(0);
    expect(ev?.suspect[0]).toMatch(/zero listings/);
  });

  it('rejects a payload that breaks the contract (commodities key as an array is fine, as a number is not)', async () => {
    const dir = tempDir();
    const { client } = fakeBlizzard({ '/data/wow/ruleset/2/auctions/110': () => ({ body: { id: 110, auctions: [{ id: 1, item: 4308, buyout: 1, quantity: 1, time_left: 'LONG' }] }, lastModified: 'x' }) });
    const c = new Collector(client, openDb(dir, ':memory:'), dir);
    await expect(c.poll(house, 'auctions')).rejects.toThrow(/Contract violation/);
  });
});
