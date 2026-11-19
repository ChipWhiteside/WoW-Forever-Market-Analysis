import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { rawPath, writeRaw } from '../../src/engine/rawstore.ts';
import { rebuildHistory, rebuildIfRulesChanged } from '../../src/engine/rebuild.ts';
import { demandByItem } from '../../src/analysis/history.ts';
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
  });
  it('runs once per version of the sale rules', () => {
    const db = openDb(tempDir(), ':memory:');
    let runs = 0;
    rebuildIfRulesChanged(db, () => runs++);
    rebuildIfRulesChanged(db, () => runs++);
    expect(runs).toBe(1);
  });
});
