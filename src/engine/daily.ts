import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../store/db.ts';
import { tx } from '../store/db.ts';
import { pruneRaw } from './rawstore.ts';

/** Roll hourly item stats older than `keepDays` into one row per item per day, then delete the hourly rows. */
export function rollup(db: DB, keepDays = 90, now = Date.now()): number {
  const cutoff = now - keepDays * 86_400_000;
  return tx(db, () => {
    db.prepare(`INSERT OR REPLACE INTO item_daily (house_id, item_id, day, floor_min, floor_median, floor_max, units_avg, sold_est, readings)
      SELECT house_id, item_id, date(published_at / 1000, 'unixepoch') d, MIN(floor), CAST(AVG(floor) AS INTEGER), MAX(floor), AVG(total_units),
        SUM(COALESCE(sold_units, MAX(0, COALESCE(gone_units_near_floor, 0) - COALESCE(gone_units_expiring_near_floor, 0)))), COUNT(*)
      FROM item_stats WHERE published_at < ? GROUP BY house_id, item_id, d`).run(cutoff);
    const r = db.prepare('DELETE FROM item_stats WHERE published_at < ?').run(cutoff);
    return Number(r.changes);
  });
}

/** Candidate houses Chip did not pin keep only 72 hours, once he has pinned one per faction. */
export function trimUnpinned(db: DB, now = Date.now()): number {
  const pinned = db.prepare(`SELECT COUNT(*) n FROM houses WHERE pinned = 1`).get() as { n: number };
  if (pinned.n === 0) return 0;
  const r = db.prepare(`DELETE FROM item_stats WHERE published_at < ? AND house_id IN (SELECT id FROM houses WHERE pinned = 0)`).run(now - 72 * 3600_000);
  return Number(r.changes);
}

/** A consistent copy of the database. Seven rolling copies. */
export function backup(db: DB, dataDir: string, keep = 7): string {
  const dir = join(dataDir, 'backups');
  const file = join(dir, `wowf-${new Date().toISOString().slice(0, 10)}.db`);
  if (existsSync(file)) rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const files = readdirSync(dir).filter(f => f.startsWith('wowf-') && f.endsWith('.db')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f));
  return file;
}

export function pruneLogs(db: DB, now = Date.now()): void {
  db.prepare('DELETE FROM poll_log WHERE at < ?').run(now - 14 * 86_400_000);
}

/**
 * How long things are kept. Local mode keeps the defaults; the cloud keeps less (src/cloud/run.ts CLOUD_RETENTION),
 * so its database stays small, and takes no local backups (the release keeps the last two databases).
 */
export interface Retention { statsKeepDays: number; rawKeepDays: number; rawKeepDaysPinned: number; backups: boolean }
export const LOCAL_RETENTION: Retention = { statsKeepDays: 90, rawKeepDays: 2, rawKeepDaysPinned: 14, backups: true };

export function dailyMaintenance(db: DB, dataDir: string, now = Date.now(), keep: Retention = LOCAL_RETENTION): Record<string, unknown> {
  const pinned = new Set((db.prepare('SELECT id FROM houses WHERE pinned = 1').all() as Array<{ id: number }>).map(r => r.id));
  const rawRemoved = pruneRaw(dataDir, keep.rawKeepDays, keep.rawKeepDaysPinned, pinned);
  const rolled = rollup(db, keep.statsKeepDays, now);
  const trimmed = trimUnpinned(db, now);
  pruneLogs(db, now);
  const file = keep.backups ? backup(db, dataDir) : null;
  return { rawRemoved, rolled, trimmed, backup: file };
}
