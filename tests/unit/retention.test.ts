/**
 * Retention (src/engine/daily.ts): the rollup keeps whole days, and the cloud keeps the hourly rows every flip window
 * needs (72 hours) while dropping the rest, with no local backups.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type DB } from '../../src/store/db.ts';
import { rollup, dailyMaintenance } from '../../src/engine/daily.ts';
import { CLOUD_RETENTION } from '../../src/cloud/run.ts';
import { tempDir } from '../helpers.ts';

const H = 3600_000, D = 86_400_000;
const DAY0 = Date.UTC(2026, 10, 1);

function withHours(db: DB, from: number, hours: number) {
  db.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES (111, 'A', 'alliance', 0.05, 1, 1)`);
  const s = db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes) VALUES (111, 'commodities', ?, ?, ?, 1, 1, 1)`);
  const i = db.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder) VALUES (?, 111, 7, ?, ?, 1, 1, 10, 1, '[]')`);
  for (let h = 0; h < hours; h++) { const t = from + h * H; const r = s.run(String(t), t, t); i.run(Number(r.lastInsertRowid), t, 100 + h); }
}

describe('retention', () => {
  it('a rollup never splits a day: two runs inside one day keep all 24 readings of the day before', () => {
    const db = openDb(tempDir());
    withHours(db, DAY0, 72);
    rollup(db, 1, DAY0 + 2 * D + 6 * H);   // cutoff aligns to the start of day 1: day 0 rolled whole
    rollup(db, 1, DAY0 + 2 * D + 18 * H);  // the same cutoff again: nothing more, nothing lost
    const d0 = db.prepare(`SELECT readings, floor_min, floor_max FROM item_daily WHERE day = '2026-11-01'`).get() as { readings: number; floor_min: number; floor_max: number };
    expect({ ...d0 }).toEqual({ readings: 24, floor_min: 100, floor_max: 123 });
    expect((db.prepare(`SELECT COUNT(*) n FROM item_daily WHERE day = '2026-11-02'`).get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM item_stats').get() as { n: number }).n).toBe(48);
  });

  it('cloud retention keeps at least 72 hours of hourly rows and takes no backup', () => {
    const dir = tempDir();
    const db = openDb(dir);
    const now = DAY0 + 10 * D + 13 * H;
    withHours(db, now - 200 * H, 200);
    const r = dailyMaintenance(db, dir, now, CLOUD_RETENTION);
    const oldest = (db.prepare('SELECT MIN(published_at) t FROM item_stats').get() as { t: number }).t;
    expect(now - oldest).toBeGreaterThanOrEqual(72 * H);
    expect(now - oldest).toBeLessThanOrEqual(96 * H);
    expect(r.backup).toBeNull();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });
});
