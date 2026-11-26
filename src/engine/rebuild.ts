import { existsSync } from 'node:fs';
import type { DB } from '../store/db.ts';
import { tx, getKv, setKv } from '../store/db.ts';
import { aggregate, nextSeen, type Listing, type Seen, type Diagnostics } from '../analysis/aggregate.ts';
import { readRaw } from './rawstore.ts';
import { MAX_DIFF_HOURS, ownTrades, saveSeen, markSeenSince, itemStatsInsert, itemStatValues, hasSoldEvents } from './collector.ts';

/**
 * Re-count stored history with the current sale rules. Blizzard only ever serves the current snapshot, so past
 * sales cannot be downloaded; but every raw snapshot the engine kept can be differenced again. This rebuilds
 * item_stats for every stored publish (floor, ladder, sales, sold price, sweeps, new posts near the floor) and the
 * hours each one covers. Listing ages are worked out again from the raw snapshots in order (first sight of each
 * listing id), and the ages of the latest publish per house and kind are written back to listing_seen so the
 * collector carries on from them.
 */
export function rebuildHistory(db: DB, log: (m: string) => void = () => {}): { snapshots: number; rebuilt: number; skipped: number; breaches: string[]; ageConflicts: number } {
  const snaps = db.prepare(`SELECT id, house_id, kind, published_at, raw_path FROM snapshots ORDER BY house_id, kind, published_at`).all() as Array<{ id: number; house_id: number; kind: string; published_at: number; raw_path: string | null }>;
  let rebuilt = 0, skipped = 0;
  const own = ownTrades(db);
  const diag: Diagnostics = { ageConflicts: 0, breaches: [] };
  const breaches: string[] = [];
  let prev: { house: number; kind: string; at: number; listings: Listing[] } | null = null;
  // First sight of each listing, per house and kind, carried across missing raw files (a missing file is a gap).
  let seen: Map<number, Seen> | null = null;
  let chain = '';
  const del = db.prepare('DELETE FROM item_stats WHERE snapshot_id = ?');
  const ins = itemStatsInsert(db);
  const withEvents = hasSoldEvents(db);
  const setHours = db.prepare('UPDATE snapshots SET diff_hours = ? WHERE id = ?');
  const finishChain = (last: typeof snaps[number] | undefined) => {
    // Hand the ages over to the collector only when the chain ended on its latest publish, read whole.
    if (!last || !seen || !prev || prev.at !== last.published_at || prev.house !== last.house_id || prev.kind !== last.kind) return;
    const items = new Map(prev.listings.map(l => [l.id, l.itemId]));
    const s = seen;
    tx(db, () => { saveSeen(db, last.house_id, last.kind, null, s, items); markSeenSince(db, last.house_id, last.kind, 0); });
  };
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    const key = `${s.house_id}:${s.kind}`;
    if (key !== chain) { chain = key; seen = null; prev = null; }
    if (!s.raw_path || !existsSync(s.raw_path)) { prev = null; skipped++; continue; }
    let listings;
    try { listings = readRaw(s.raw_path); } catch { prev = null; skipped++; continue; }
    const samePair = prev && prev.house === s.house_id && prev.kind === s.kind;
    const hours = samePair ? (s.published_at - prev!.at) / 3600_000 : null;
    let diffable = !!samePair && hours != null && hours > 0 && hours <= MAX_DIFF_HOURS;
    if (diffable && prev!.listings.length > 100) {
      const now = new Set(listings.map(l => l.id));
      const vanished = prev!.listings.filter(l => !now.has(l.id)).length;
      if (vanished / prev!.listings.length > 0.3) diffable = false;
    }
    const seenBefore = seen;
    seen = nextSeen(seenBefore, listings, s.published_at, prev ? { listings: prev.listings, at: prev.at } : null, diffable);
    diag.breaches = [];
    const stats = aggregate(listings, diffable ? prev!.listings : null, {
      commodity: s.kind === 'commodities', prevAt: diffable ? prev!.at : undefined, curAt: s.published_at, seen: seenBefore ?? undefined, own, diag,
    });
    for (const b of diag.breaches) breaches.push(`house ${s.house_id} ${s.kind} at ${new Date(s.published_at).toISOString()}: ${b}`);
    tx(db, () => {
      del.run(s.id);
      for (const r of stats) ins.run(...itemStatValues(s.id, s.house_id, s.published_at, r, withEvents));
      setHours.run(diffable ? hours : null, s.id);
    });
    rebuilt++;
    prev = { house: s.house_id, kind: s.kind, at: s.published_at, listings };
    const next = snaps[i + 1];
    if (!next || `${next.house_id}:${next.kind}` !== key) finishChain(s);
  }
  log(`history rebuilt with current sale rules: ${rebuilt} snapshots re-counted, ${skipped} without raw data`);
  if (breaches.length) log(`suspected bug: a stack grew, so units judged sold exceeded what left the house, ${breaches.length} times (${breaches.slice(0, 3).join('; ')})`);
  if (diag.ageConflicts) log(`suspected bug: ${diag.ageConflicts} vanished listings had a time left that contradicts their age`);
  return { snapshots: snaps.length, rebuilt, skipped, breaches, ageConflicts: diag.ageConflicts };
}

/** Rebuild once per version of the sale rules. Bump the version whenever aggregate's sale logic changes. */
export const SALE_RULES_VERSION = '2026-11-26';
export function rebuildIfRulesChanged(db: DB, log: (m: string) => void): void {
  // Once a migration adds item_stats.sold_events (P14), the history is re-counted once more to fill it.
  const version = SALE_RULES_VERSION + (hasSoldEvents(db) ? '+events' : '');
  if (getKv(db, 'sale_rules_version') === version) return;
  rebuildHistory(db, log);
  setKv(db, 'sale_rules_version', version);
}
