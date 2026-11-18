import type { DB } from '../store/db.ts';
import type { Demand } from '../detectors/types.ts';

/**
 * Estimated units sold per day near the floor, per item, for one house.
 * A listing that vanished between publishes, priced within 10 percent of the floor and not about to expire,
 * most likely sold. Cancellations still leak in, so this is provisional by nature (spec 12.1).
 * The window stretches backward after a gap: it always looks at the last `snapshots` differenced publishes.
 */
export function demandByItem(db: DB, houseId: number, opts: { hours?: number; now?: number } = {}): Map<number, Demand> {
  const now = opts.now ?? Date.now();
  const hours = opts.hours ?? 72;
  const since = now - hours * 3600_000;
  // Differenced publishes per kind in the window. Each one covers roughly one hour.
  const snaps = db.prepare(`SELECT kind, COUNT(*) n, MIN(published_at) first FROM snapshots
     WHERE house_id = ? AND published_at >= ? AND id IN (SELECT DISTINCT snapshot_id FROM item_stats WHERE house_id = ? AND published_at >= ? AND gone_units IS NOT NULL)
     GROUP BY kind`).all(houseId, since, houseId, since) as Array<{ kind: string; n: number; first: number }>;
  const covered = Math.max(0, ...snaps.map(s => s.n));
  const out = new Map<number, Demand>();
  if (covered === 0) return out;
  const rows = db.prepare(`SELECT item_id, SUM(MAX(0, COALESCE(gone_units_near_floor, 0) - COALESCE(gone_units_expiring, 0))) sold, COUNT(*) n
     FROM item_stats WHERE house_id = ? AND published_at >= ? AND gone_units IS NOT NULL GROUP BY item_id`).all(houseId, since) as Array<{ item_id: number; sold: number; n: number }>;
  for (const r of rows) out.set(r.item_id, { unitsPerDay: (r.sold / covered) * 24, hours: covered, snapshots: r.n });
  return out;
}

export interface Typical { typicalFloor: number; readings: number }

/**
 * Typical floor: the median of hourly floors over the window. Exists only after `minReadings` readings.
 * A statistic of the floor over time, never a median of listing prices (spec 5).
 */
export function typicalFloors(db: DB, houseId: number, opts: { hours?: number; minReadings?: number; now?: number } = {}): Map<number, Typical> {
  const now = opts.now ?? Date.now();
  const since = now - (opts.hours ?? 72) * 3600_000;
  const min = opts.minReadings ?? 24;
  const rows = db.prepare(`SELECT item_id, floor FROM item_stats WHERE house_id = ? AND published_at >= ? AND floor IS NOT NULL ORDER BY item_id, floor`)
    .all(houseId, since) as Array<{ item_id: number; floor: number }>;
  const out = new Map<number, Typical>();
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j]!.item_id === rows[i]!.item_id) j++;
    const n = j - i;
    if (n >= min) {
      const mid = i + Math.floor(n / 2);
      const median = n % 2 ? rows[mid]!.floor : Math.round((rows[mid - 1]!.floor + rows[mid]!.floor) / 2);
      out.set(rows[i]!.item_id, { typicalFloor: median, readings: n });
    }
    i = j;
  }
  return out;
}

/** How many hourly readings exist for this house, for the "learning, N of 24 hours" cold start label. */
export function readingsSoFar(db: DB, houseId: number, hours = 72, now = Date.now()): number {
  const r = db.prepare(`SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM snapshots WHERE house_id = ? AND published_at >= ? GROUP BY kind)`).get(houseId, now - hours * 3600_000) as { n: number | null };
  return r.n ?? 0;
}
