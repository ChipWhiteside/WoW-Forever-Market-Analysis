import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { rawPath, writeRaw } from '../../src/engine/rawstore.ts';
import { rebuildHistory, rebuildIfRulesChanged } from '../../src/engine/rebuild.ts';
import { demandByItem, poissonLower, PULL_RATE } from '../../src/analysis/history.ts';
import { loadSeen } from '../../src/engine/collector.ts';
import type { Listing } from '../../src/analysis/aggregate.ts';
import { tempDir } from '../helpers.ts';

const L = (id: number, itemId: number, quantity: number, unitPrice: number, timeLeft: Listing['timeLeft'] = 'LONG'): Listing => ({ id, itemId, quantity, unitPrice, timeLeft });

describe('rebuilding history from raw snapshots', () => {
  it('re-counts old inflated history with the current rules, keeping real sales and dropping expiries', () => {
    const dir = tempDir();
    const db = openDb(dir, ':memory:');
    const t0 = Date.parse('2026-11-19T08:25:00Z');
    // Three hours: Coal sells 40 an hour from the cheapest stacks; hammers at 1s are 2 hour listings that expire and get reposted.
    const hours = [
      [L(1, 3857, 20, 800), L(2, 3857, 20, 800), L(3, 3857, 20, 820), L(4, 3857, 20, 820), L(5, 3857, 20, 830), L(6, 3857, 20, 830), L(10, 5956, 1, 100, 'MEDIUM')],
      [L(3, 3857, 20, 820), L(4, 3857, 20, 820), L(5, 3857, 20, 830), L(6, 3857, 20, 830), L(11, 5956, 1, 100, 'MEDIUM')],
      [L(5, 3857, 20, 830), L(6, 3857, 20, 830), L(12, 5956, 1, 100, 'MEDIUM')],
    ];
    hours.forEach((ls, i) => {
      const at = t0 + i * 3600_000;
      const path = rawPath(dir, 111, 'commodities', at);
      writeRaw(path, ls);
      db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path) VALUES (111, 'commodities', ?, ?, ?, ?, 2, 1, ?)`)
        .run(new Date(at).toUTCString(), at, at, ls.length, path);
    });
    // Before: no usable sales history (old rows have no sold price).
    expect(demandByItem(db, 111, { now: t0 + 3 * 3600_000 }).size).toBe(0);
    const r = rebuildHistory(db);
    expect(r.rebuilt).toBe(3);
    const d = demandByItem(db, 111, { now: t0 + 3 * 3600_000 });
    expect(d.get(3857)?.unitsPerDay).toBeCloseTo(80 / 6 * 24, 0); // 80 sold, projected from at least 6 hours
    expect(d.get(3857)?.soldPrice).toBe(810); // 40 at 800, 40 at 820
    expect(d.get(5956)?.unitsPerDay ?? 0).toBe(0); // the expiring hammer relists are not sales
    // The cautious estimate is not projected from 2 hours of watching. With sold_events each run of stacks taken
    // from the front in one hour is one sale (one buyer): stacks 1 and 2, then 3 and 4, so 2 sales of 40.
    const coal = d.get(3857)!;
    expect(coal.soldUnits).toBe(80);
    expect(coal.saleEvents).toBe(2);
    expect(coal.unitsPerEvent).toBe(40);
    expect(coal.hoursWatched).toBe(2);
    expect(coal.lowPerDay).toBeNull();
    expect(coal.sweepHigh).toBe(820);
    expect(coal.low3d).toBe(800);
    expect(coal.newPerDay).toBe(0);
    expect(d.get(5956)?.newPerDay).toBe(24); // one new hammer at the floor each hour
    // ...and one pulled each hour (expired, then pulled and posted again), so the queue near the floor does not grow.
    expect(d.get(5956)?.pulledPerDay).toBe(24);
    expect(coal.pulledPerDay).toBe(0);
    // Ages handed to the collector: the last publish's listings, the hammer posted after the 09:25 publish.
    const seen = loadSeen(db, 111, 'commodities');
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([5, 6, 12]);
    expect(seen.get(12)).toEqual({ firstSeen: t0 + 2 * 3600_000, firstTimeLeft: 'MEDIUM', postedAfter: t0 + 3600_000 });
    expect(seen.get(5)!.postedAfter).toBeNull(); // up since the first publish: age unknown
  });

  it('re-counts a 2 hour listing that sold in its first hour, which the old rules threw away as expired', () => {
    const dir = tempDir();
    const db = openDb(dir, ':memory:');
    const t0 = Date.parse('2026-11-19T08:25:00Z');
    const hours = [
      [L(1, 2589, 20, 30, 'VERY_LONG')],
      [L(1, 2589, 20, 30, 'VERY_LONG'), L(2, 2589, 10, 28, 'MEDIUM')],
      [L(1, 2589, 20, 30, 'VERY_LONG')],
    ];
    hours.forEach((ls, i) => {
      const at = t0 + i * 3600_000;
      const path = rawPath(dir, 111, 'commodities', at);
      writeRaw(path, ls);
      db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path) VALUES (111, 'commodities', ?, ?, ?, ?, 1, 1, ?)`)
        .run(new Date(at).toUTCString(), at, at, ls.length, path);
    });
    const r = rebuildHistory(db);
    expect(r.breaches).toEqual([]);
    const row = db.prepare(`SELECT sold_units, sweep_high, gone_units_expiring FROM item_stats WHERE published_at = ?`).get(t0 + 2 * 3600_000);
    expect(row).toEqual({ sold_units: 10, sweep_high: 28, gone_units_expiring: 0 });
  });
  it('the low estimate counts sale events, not units: stacks of 15, 48 and 221 bought in three hours are 3 sales, one sweep is 1', () => {
    const dir = tempDir();
    const db = openDb(dir, ':memory:');
    const t0 = Date.parse('2026-11-19T08:25:00Z');
    // Seven publishes, six differenced hours. Hours 1 to 3 one stack sells each; nothing else sells. Item 12211: the
    // same three stacks all go in hour 1, one run from the front of the buy order: one buyer, one sale.
    const deep = [10, 11, 12, 13, 14, 15].map(id => L(id, 12210, 20, 900, 'VERY_LONG'));
    const deep2 = [20, 21, 22, 23, 24, 25].map(id => L(id, 12211, 20, 900, 'VERY_LONG'));
    const s1 = L(1, 12210, 15, 500, 'VERY_LONG'), s2 = L(2, 12210, 48, 510, 'VERY_LONG'), s3 = L(3, 12210, 221, 520, 'VERY_LONG');
    const w = [L(4, 12211, 15, 500, 'VERY_LONG'), L(5, 12211, 48, 510, 'VERY_LONG'), L(6, 12211, 221, 520, 'VERY_LONG')];
    const hours = [[s1, s2, s3, ...deep, ...w, ...deep2], [s2, s3, ...deep, ...deep2], [s3, ...deep, ...deep2], ...Array.from({ length: 4 }, () => [...deep, ...deep2])];
    hours.forEach((ls, i) => {
      const at = t0 + i * 3600_000;
      const path = rawPath(dir, 111, 'commodities', at);
      writeRaw(path, ls);
      db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path) VALUES (111, 'commodities', ?, ?, ?, ?, 1, 1, ?)`)
        .run(new Date(at).toUTCString(), at, at, ls.length, path);
    });
    rebuildHistory(db);
    const d = demandByItem(db, 111, { now: t0 + 7 * 3600_000 }).get(12210)!;
    expect(d.soldUnits).toBe(284);
    expect(d.saleEvents).toBe(3);
    expect(d.unitsPerEvent).toBeCloseTo(284 / 3, 6);
    expect(d.hoursWatched).toBe(6);
    expect(d.unitsPerDay).toBeCloseTo(284 / 6 * 24, 6);
    // 95% lower bound of 3 events is 0.818, less the pulls of the front stack expected to read as sales: 6 hours of a
    // deep market (more than 5 listings) at 2.2% an hour, times the chance an hour had no real sale (3 of 6 had none),
    // is 0.066. (0.818 - 0.066) * 94.7 / 6 * 24 = 285 a day, against 1,136 in the middle. The hourly bound is 0 here:
    // three busy hours and three empty ones are too uneven to prove much.
    expect(d.pullEvents).toBeCloseTo(6 * PULL_RATE.deep * 0.5, 6);
    expect(d.lowPerDay).toBeCloseTo((poissonLower(3) - 3 * PULL_RATE.deep) * (284 / 3) / 6 * 24, 6);
    expect(d.hourlyMean).toBeCloseTo(284 / 6, 6);
    expect(d.hourlySd).toBeCloseTo(Math.sqrt((15 ** 2 + 48 ** 2 + 221 ** 2 - 6 * (284 / 6) ** 2) / 5), 6);
    expect(d.lowPerDay! / d.unitsPerDay).toBeLessThan(0.3);
    const sweep = demandByItem(db, 111, { now: t0 + 7 * 3600_000 }).get(12211)!;
    expect(sweep.soldUnits).toBe(284);
    expect(sweep.saleEvents).toBe(1);
    // One buyer in 6 hours: its lower bound (0.051) is under the pulls expected to read as sales (0.11), and one busy
    // hour in six proves nothing hourly, so the cautious estimate is 0. One sale could have been a pull of the front.
    expect(sweep.lowPerDay).toBe(0);
  });

  it('equipment takes no pull allowance, hours watched are per kind, the low estimate waits for 6 publishes and tracks steady sales', () => {
    const dir = tempDir();
    const db = openDb(dir, ':memory:');
    const t0 = Date.parse('2026-11-19T08:25:00Z');
    // Equipment: copies at 1000, 1100, 1200 (in band) and 2000 (out); one copy at 1000 sells each hour. Publishes
    // 59.9 minutes apart, so 6 differenced publishes sum to 5.99 hours.
    const gap = 3_594_000;
    const stock = (h: number) => [...Array.from({ length: 8 - h }, (_, i) => L(100 + h + i, 7001, 1, 1000)), L(1, 7001, 1, 1100), L(2, 7001, 1, 1200), L(3, 7001, 1, 2000)];
    for (let h = 0; h <= 6; h++) {
      const at = t0 + h * gap;
      const path = rawPath(dir, 111, 'auctions', at);
      writeRaw(path, stock(h));
      db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path) VALUES (111, 'auctions', ?, ?, ?, 1, 1, 1, ?)`)
        .run(new Date(at).toUTCString(), at, at, path);
    }
    rebuildHistory(db);
    const d = demandByItem(db, 111, { now: t0 + 6 * gap + 1 })!.get(7001)!;
    expect(d.saleEvents).toBe(6);
    expect(d.hoursWatched).toBe(6); // 5.99 rounded
    expect(d.lowPerDay).not.toBeNull(); // 6 publishes, though under 6 hours
    // Equipment: the counter's missed buys offset the pulls (B42), so no allowance and the middle is left as it is.
    expect(d.pullEvents).toBe(0);
    expect(d.netPerDay).toBeCloseTo(d.unitsPerDay, 6);
    // One sale every hour, no spread: the hourly bound proves the full rate, capped at the middle (24 a day). The event
    // bound alone would give poissonLower(6) / 5.99 * 24 = 10.5.
    expect(d.hourlySd).toBe(0);
    expect(d.lowPerDay).toBeCloseTo(d.unitsPerDay, 6);
    // 5 publishes: no low estimate yet.
    expect(demandByItem(db, 111, { now: t0 + 5 * gap + 1 }).get(7001)!.lowPerDay).toBeNull();
  });

  it('runs once per version of the sale rules', () => {
    const db = openDb(tempDir(), ':memory:');
    let runs = 0;
    rebuildIfRulesChanged(db, () => runs++);
    rebuildIfRulesChanged(db, () => runs++);
    expect(runs).toBe(1);
    // sold_events exists from migration 13, so nothing triggers a second re-count.
    rebuildIfRulesChanged(db, () => runs++);
    expect(runs).toBe(1);
  });
});
