import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { rawPath, writeRaw } from '../../src/engine/rawstore.ts';
import { rebuildHistory, rebuildIfRulesChanged } from '../../src/engine/rebuild.ts';
import { demandByItem, poissonLower } from '../../src/analysis/history.ts';
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
    // The cautious estimate is not projected from 2 hours of watching. Without a sold_events column, a commodity hour
    // with sales is one event: 2 events of 40 units.
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
  it('the low estimate counts sale events, not units: three stacks of 221, 48 and 15 are 3 sales (Clam Linguine)', () => {
    const dir = tempDir();
    const db = openDb(dir, ':memory:');
    db.exec('ALTER TABLE item_stats ADD COLUMN sold_events INTEGER'); // the migration this needs, made here for the test
    const t0 = Date.parse('2026-11-19T08:25:00Z');
    // Seven publishes, six differenced hours. Hour 1 the three cheapest stacks sell; nothing else sells.
    const deep = [10, 11, 12, 13, 14, 15].map(id => L(id, 12210, 20, 900, 'VERY_LONG'));
    const hours = [[L(1, 12210, 221, 500, 'VERY_LONG'), L(2, 12210, 48, 510, 'VERY_LONG'), L(3, 12210, 15, 520, 'VERY_LONG'), ...deep], ...Array.from({ length: 6 }, () => deep)];
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
    // 95% lower bound of 3 events is 0.818: 0.818 * 94.7 / 6 * 24 = 310 a day, against 1,136 in the middle.
    expect(d.lowPerDay).toBeCloseTo(poissonLower(3) * (284 / 3) / 6 * 24, 6);
    expect(d.lowPerDay! / d.unitsPerDay).toBeLessThan(0.3);
  });

  it('runs once per version of the sale rules', () => {
    const db = openDb(tempDir(), ':memory:');
    let runs = 0;
    rebuildIfRulesChanged(db, () => runs++);
    rebuildIfRulesChanged(db, () => runs++);
    expect(runs).toBe(1);
    // A migration adding sold_events re-counts once more so the column gets filled.
    db.exec('ALTER TABLE item_stats ADD COLUMN sold_events INTEGER');
    rebuildIfRulesChanged(db, () => runs++);
    rebuildIfRulesChanged(db, () => runs++);
    expect(runs).toBe(2);
  });
});
