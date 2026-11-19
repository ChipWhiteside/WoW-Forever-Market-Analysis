import { existsSync } from 'node:fs';
import type { DB } from '../store/db.ts';
import { tx, getKv, setKv } from '../store/db.ts';
import { aggregate } from '../analysis/aggregate.ts';
import { readRaw } from './rawstore.ts';
import { MAX_DIFF_HOURS } from './collector.ts';

/**
 * Re-count stored history with the current sale rules. Blizzard only ever serves the current snapshot, so past
 * sales cannot be downloaded; but every raw snapshot the engine kept can be differenced again. This rebuilds
 * item_stats for every stored publish (floor, ladder, sales, sold price) and the hours each one covers.
 */
export function rebuildHistory(db: DB, log: (m: string) => void = () => {}): { snapshots: number; rebuilt: number; skipped: number } {
  const snaps = db.prepare(`SELECT id, house_id, kind, published_at, raw_path FROM snapshots ORDER BY house_id, kind, published_at`).all() as Array<{ id: number; house_id: number; kind: string; published_at: number; raw_path: string | null }>;
  let rebuilt = 0, skipped = 0;
  let prev: { house: number; kind: string; at: number; listings: ReturnType<typeof readRaw> } | null = null;
  const del = db.prepare('DELETE FROM item_stats WHERE snapshot_id = ?');
  const ins = db.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder,
    gone_listings, gone_units, gone_units_expiring, gone_units_near_floor, new_units, gone_units_expiring_near_floor, sold_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const setHours = db.prepare('UPDATE snapshots SET diff_hours = ? WHERE id = ?');
  for (const s of snaps) {
    if (!s.raw_path || !existsSync(s.raw_path)) { prev = null; skipped++; continue; }
    let listings;
    try { listings = readRaw(s.raw_path); } catch { prev = null; skipped++; continue; }
    const samePair = prev && prev.house === s.house_id && prev.kind === s.kind;
    const hours = samePair ? (s.published_at - prev!.at) / 3600_000 : null;
    let diffable = samePair && hours != null && hours > 0 && hours <= MAX_DIFF_HOURS;
    if (diffable && prev!.listings.length > 100) {
      const now = new Set(listings.map(l => l.id));
      const vanished = prev!.listings.filter(l => !now.has(l.id)).length;
      if (vanished / prev!.listings.length > 0.3) diffable = false;
    }
    const stats = aggregate(listings, diffable ? prev!.listings : null, { commodity: s.kind === 'commodities' });
    tx(db, () => {
      del.run(s.id);
      for (const r of stats) ins.run(s.id, s.house_id, r.itemId, s.published_at, r.floor, r.unitsAtFloor, r.unitsWithin5, r.totalUnits, r.listings, JSON.stringify(r.ladder),
        r.goneListings, r.goneUnits, r.goneUnitsExpiring, r.goneUnitsNearFloor, r.newUnits, r.goneUnitsExpiringNearFloor, r.soldValue);
      setHours.run(diffable ? hours : null, s.id);
    });
    rebuilt++;
    prev = { house: s.house_id, kind: s.kind, at: s.published_at, listings };
  }
  log(`history rebuilt with current sale rules: ${rebuilt} snapshots re-counted, ${skipped} without raw data`);
  return { snapshots: snaps.length, rebuilt, skipped };
}

/** Rebuild once per version of the sale rules. Bump the version whenever aggregate's sale logic changes. */
export const SALE_RULES_VERSION = '2026-11-19b';
export function rebuildIfRulesChanged(db: DB, log: (m: string) => void): void {
  if (getKv(db, 'sale_rules_version') === SALE_RULES_VERSION) return;
  rebuildHistory(db, log);
  setKv(db, 'sale_rules_version', SALE_RULES_VERSION);
}
