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
  // Hours actually covered by differencing, per kind: the sum of the gaps between consecutive publishes
  // that were differenced. Gaps over 1.6 hours are never differenced, so outages cannot inflate demand.
  // Only rows counted with the current method (they carry sold_value). Rows from before it counted expiries and
  // relists as sales, so they are left out rather than mixed in.
  const snaps = db.prepare(`SELECT kind, SUM(diff_hours) h FROM snapshots WHERE house_id = ? AND published_at >= ? AND diff_hours IS NOT NULL
     AND id IN (SELECT DISTINCT snapshot_id FROM item_stats WHERE house_id = ? AND published_at >= ? AND sold_value IS NOT NULL) GROUP BY kind`)
    .all(houseId, since, houseId, since) as Array<{ kind: string; h: number }>;
  const covered = Math.max(0, ...snaps.map(s => s.h ?? 0));
  const out = new Map<number, Demand>();
  if (covered <= 0) return out;
  const rows = db.prepare(`SELECT item_id, SUM(MAX(0, COALESCE(gone_units_near_floor, 0) - COALESCE(gone_units_expiring_near_floor, 0))) sold,
     SUM(COALESCE(sold_value, 0)) value, COUNT(*) n
     FROM item_stats WHERE house_id = ? AND published_at >= ? AND gone_units IS NOT NULL AND sold_value IS NOT NULL GROUP BY item_id`).all(houseId, since) as Array<{ item_id: number; sold: number; value: number; n: number }>;
  const recent = new Map((db.prepare(`SELECT item_id, SUM(MAX(0, COALESCE(gone_units_near_floor, 0) - COALESCE(gone_units_expiring_near_floor, 0))) sold, SUM(COALESCE(sold_value, 0)) value
     FROM item_stats WHERE house_id = ? AND published_at >= ? AND gone_units IS NOT NULL AND sold_value IS NOT NULL GROUP BY item_id`).all(houseId, now - 24 * 3600_000) as Array<{ item_id: number; sold: number; value: number }>)
    .map(r => [r.item_id, r]));
  // Steadiness: how far the hourly floor wanders over the window (standard deviation over mean).
  const steady = new Map((db.prepare(`SELECT item_id, AVG(floor) m, AVG(floor * floor) m2, COUNT(*) n FROM item_stats WHERE house_id = ? AND published_at >= ? AND floor IS NOT NULL GROUP BY item_id`)
    .all(houseId, since) as Array<{ item_id: number; m: number; m2: number; n: number }>).map(r => [r.item_id, r.n >= 6 && r.m > 0 ? Math.sqrt(Math.max(0, r.m2 - r.m * r.m)) / r.m : null]));
  for (const r of rows) {
    const rc = recent.get(r.item_id);
    out.set(r.item_id, { unitsPerDay: (r.sold / covered) * 24, hours: Math.round(covered * 10) / 10, snapshots: r.n, soldPrice: r.sold > 0 && r.value > 0 ? Math.round(r.value / r.sold) : null,
      recentSales: rc?.sold ?? 0, recentSoldPrice: rc && rc.sold > 0 && rc.value > 0 ? Math.round(rc.value / rc.sold) : null, floorCv: steady.get(r.item_id) ?? null });
  }
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
