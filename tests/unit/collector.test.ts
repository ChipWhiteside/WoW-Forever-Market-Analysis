import { describe, it, expect } from 'vitest';
import { openDb, getKv } from '../../src/store/db.ts';
import { Collector, loadSeen, ownTrades, diagSuspects } from '../../src/engine/collector.ts';
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
    expect(d.unitsPerDay).toBeCloseTo(28, 0); // 7 sold, projected from at least 6 hours of watching, never fewer
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

describe('listing ages in the collector', () => {
  const route = '/data/wow/ruleset/2/auctions/110/commodities';
  const at = (h: number) => `Wed, 18 Nov 2026 0${h}:25:00 GMT`;
  const row = (id: number, quantity: number, unit_price: number, time_left: string) => ({ id, item: { id: 2770 }, quantity, unit_price, time_left });

  it('keeps first sight per listing in listing_seen, survives a restart, and counts a fresh 2 hour listing that sold', async () => {
    const dir = tempDir();
    let lm = at(4);
    let rows = [row(1, 20, 150, 'LONG')];
    const { client } = fakeBlizzard({ [route]: () => ({ body: { _links: {}, auctions: rows }, lastModified: lm }) });
    const db = openDb(dir, ':memory:');
    await new Collector(client, db, dir).poll(house, 'commodities');
    lm = at(5);
    rows = [row(1, 20, 150, 'LONG'), row(2, 5, 140, 'MEDIUM')]; // a new 2 hour listing
    const second = await new Collector(client, db, dir).poll(house, 'commodities');
    expect(second?.stats[0]?.newNearFloor).toBe(5);
    const seen = db.prepare('SELECT listing_id, first_seen, first_time_left FROM listing_seen ORDER BY listing_id').all() as Array<{ listing_id: number; first_seen: number; first_time_left: string }>;
    expect(seen.map(s => [s.listing_id, s.first_time_left])).toEqual([[1, 'LONG'], [2, 'MEDIUM']]);
    expect(seen[1]!.first_seen).toBe(Date.parse(at(5)));

    // Restart: a fresh collector reads the ages back. The 2 hour listing vanished in its first hour: it sold.
    lm = at(6);
    rows = [row(1, 20, 150, 'LONG')];
    const third = await new Collector(client, db, dir).poll(house, 'commodities');
    expect(third?.stats[0]?.soldUnits).toBe(5);
    expect(third?.stats[0]?.goneUnitsExpiring).toBe(0);
    expect(third?.suspect).toEqual([]);
    const stored = db.prepare(`SELECT sold_units, sweep_high, sold_value FROM item_stats WHERE published_at = ?`).get(Date.parse(at(6))) as { sold_units: number; sweep_high: number; sold_value: number };
    expect(stored).toEqual({ sold_units: 5, sweep_high: 140, sold_value: 700 });
    // Pruned to the current listings.
    expect((db.prepare('SELECT listing_id FROM listing_seen').all() as Array<{ listing_id: number }>).map(r => r.listing_id)).toEqual([1]);
  });

  it('after an update with no ages stored, listings already up get an unknown age, never a fresh one', async () => {
    const dir = tempDir();
    let lm = at(4);
    let rows = [row(1, 20, 150, 'LONG')];
    const { client } = fakeBlizzard({ [route]: () => ({ body: { _links: {}, auctions: rows }, lastModified: lm }) });
    const db = openDb(dir, ':memory:');
    await new Collector(client, db, dir).poll(house, 'commodities');
    lm = at(5);
    rows = [row(1, 20, 150, 'LONG'), row(2, 5, 140, 'MEDIUM')];
    await new Collector(client, db, dir).poll(house, 'commodities');
    db.exec('DELETE FROM listing_seen'); // as if the engine ran before ages were recorded
    lm = at(6);
    rows = [row(1, 20, 150, 'LONG')];
    const third = await new Collector(client, db, dir).poll(house, 'commodities');
    // Age unknown and MEDIUM: it may have run out, so it is not counted as a sale.
    expect(third?.stats[0]?.soldUnits).toBe(0);
    expect(getKv(db, 'listing_seen_since:110:commodities')).toBe(String(Date.parse(at(5))));
    const restored = loadSeen(db, 110, 'commodities').get(1)!;
    expect(restored.postedAfter).toBeNull(); // seeded at 05:25, so unknown age even after a restart
  });

  it('own trades hook: settings key own_trade_listing_ids keeps listings out of sales', async () => {
    const db = openDb(tempDir(), ':memory:');
    expect(ownTrades(db)).toBeUndefined();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('own_trade_listing_ids', '[5, 6]')`).run();
    expect([...ownTrades(db)!.listingIds]).toEqual([5, 6]);
  });

  it('turns sale bound breaches and age conflicts into one suspected bug line each', () => {
    expect(diagSuspects(111, 'commodities', { ageConflicts: 0, breaches: [] })).toEqual([]);
    const s = diagSuspects(111, 'commodities', { ageConflicts: 3, breaches: ['item 7: 10 judged sold, only 0 left the house'] });
    expect(s).toHaveLength(2);
    expect(s[0]).toMatch(/exceeded what left the house on 1 item \(item 7/);
  });
});

describe('old history', () => {
  it('rows counted before the sold price existed are left out of demand', async () => {
    const db = openDb(tempDir(), ':memory:');
    const t = Date.parse('Wed, 18 Nov 2026 05:25:00 GMT');
    db.exec(`INSERT INTO snapshots (id, house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, diff_hours) VALUES (1, 110, 'commodities', 'a', ${t}, ${t}, 1, 1, 1, 1)`);
    db.exec(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder, gone_units, gone_units_near_floor, gone_units_expiring_near_floor, sold_value)
      VALUES (1, 110, 5956, ${t}, 100, 1, 1, 1, 1, '[]', 48, 48, 0, NULL)`);
    expect(demandByItem(db, 110, { now: t + 60_000 }).get(5956)).toBeUndefined();
  });
});
