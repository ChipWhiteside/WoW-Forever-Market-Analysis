import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { dailyMaintenance, LOCAL_RETENTION } from '../../src/engine/daily.ts';
import { CLOUD_RETENTION } from '../../src/cloud/run.ts';
import { tempDir } from '../helpers.ts';

/** Daily rollups feed only the Market trends: forever locally, 30 days in the cloud (phase 2, November 27). */
describe('daily rollup retention', () => {
  const seed = () => {
    const dir = tempDir();
    const db = openDb(dir, ':memory:');
    const ins = db.prepare('INSERT INTO item_daily (house_id, item_id, day, floor_min, floor_median, floor_max, units_avg, sold_est, readings) VALUES (111, 2589, ?, 1, 1, 1, 1, 1, 1)');
    for (const day of ['2026-09-01', '2026-10-20', '2026-11-20']) ins.run(day);
    return { db, dir };
  };
  const now = Date.parse('2026-11-27T12:00:00Z');
  const days = (db: ReturnType<typeof openDb>) => (db.prepare('SELECT day FROM item_daily ORDER BY day').all() as Array<{ day: string }>).map(r => r.day);
  it('the cloud keeps 30 days of rollups', () => {
    const { db, dir } = seed();
    dailyMaintenance(db, dir, now, CLOUD_RETENTION);
    expect(days(db)).toEqual(['2026-11-20']);
  });
  it('local mode keeps them forever', () => {
    const { db, dir } = seed();
    dailyMaintenance(db, dir, now, { ...LOCAL_RETENTION, backups: false });
    expect(days(db)).toEqual(['2026-09-01', '2026-10-20', '2026-11-20']);
  });
});
