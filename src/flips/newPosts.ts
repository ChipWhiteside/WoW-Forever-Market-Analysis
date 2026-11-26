import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from '../store/db.ts';
import type { Listing } from '../analysis/aggregate.ts';
import { rawPath, readRaw } from '../engine/rawstore.ts';
import { NEW_POSTS } from '../rules/flips.ts';

/**
 * New listings other sellers posted, by price, from the raw snapshots (round 2 finding H2). A listing is new when its id
 * is in a differenced publish and not in the publish before it. Only units at or under Chip's own post price compete
 * with him overnight, and the hourly counts in item_stats are only "near the floor" (1.1 times), so the competition is
 * worked out here from the listings themselves, at each item's post price (newPerDayAt).
 */
export interface NewPosts {
  /** hours of differenced publishes read (the least over the two listing kinds) */
  hours: number;
  /** per item, new units by unit price, cheapest first */
  byItem: Map<number, Array<[price: number, units: number]>>;
}

/**
 * New units per day at or under 1.05 times `post` (NEW_POSTS.competeShare); null when under NEW_POSTS.minHours were
 * watched (not measured yet). A seller who undercuts the floor of his own hour posts just above a price that has since
 * fallen; counting only posts at or under today's price read such a war as 0 (whole system review round 2, defect A).
 */
export function newPerDayAt(np: NewPosts | undefined, itemId: number, post: number): number | null {
  if (!np || np.hours < NEW_POSTS.minHours) return null;
  const top = post * NEW_POSTS.competeShare;
  let units = 0;
  for (const [p, u] of np.byItem.get(itemId) ?? []) { if (p > top) break; units += u; }
  return (units / np.hours) * 24;
}

/** The data directory a database lives in, from SQLite itself; null for an in-memory database. */
export function dataDirOf(db: DB): string | null {
  const row = (db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find(r => r.name === 'main');
  return row?.file ? dirname(row.file) : null;
}

// Each pair of publishes is read once per process: the hourly run only reads the newest pair.
const pairMemo = new Map<string, Map<number, Map<number, number>>>();
const PAIR_MEMO_MAX = 400;

function newInPair(prev: Listing[], cur: Listing[]): Map<number, Map<number, number>> {
  const seen = new Set(prev.map(l => l.id));
  const out = new Map<number, Map<number, number>>();
  for (const l of cur) {
    if (seen.has(l.id) || l.unitPrice == null || l.unitPrice <= 0) continue;
    let m = out.get(l.itemId);
    if (!m) out.set(l.itemId, (m = new Map()));
    m.set(l.unitPrice, (m.get(l.unitPrice) ?? 0) + l.quantity);
  }
  return out;
}

/**
 * Read the new listings of one house over the last `windowHours` of differenced publishes at or before `now`: the same
 * window (72 hours) and the same publishes as sale counting (src/analysis/history.ts demandByItem: differenced, with
 * rows counted with a sold price), so competition and sales are measured over the same hours (round 2, defect B).
 * Null when the raw snapshots are not on disk (an in-memory database, or a data copy without raw/): the caller then
 * falls back to sale counting's newPerDay.
 */
export function newPostsFromRaw(db: DB, houseId: number, now: number, windowHours = NEW_POSTS.windowHours): NewPosts | null {
  const dataDir = dataDirOf(db);
  if (!dataDir) return null;
  const since = now - windowHours * 3600_000;
  const snaps = db.prepare(`SELECT kind, published_at t, diff_hours h,
      EXISTS (SELECT 1 FROM item_stats i WHERE i.snapshot_id = snapshots.id AND i.sold_value IS NOT NULL) counted
    FROM snapshots WHERE house_id = ? AND published_at <= ? AND published_at > ? ORDER BY kind, published_at`)
    .all(houseId, now, since - 2 * 3600_000) as Array<{ kind: string; t: number; h: number | null; counted: number }>;
  const agg = new Map<number, Map<number, number>>();
  const hoursByKind = new Map<string, number>();
  let read = 0;
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1]!, cur = snaps[i]!;
    if (prev.kind !== cur.kind || cur.h == null || !cur.counted || cur.t < since) continue;
    const key = `${houseId}:${cur.kind}:${prev.t}:${cur.t}`;
    let pair = pairMemo.get(key);
    if (!pair) {
      const pp = rawPath(dataDir, houseId, prev.kind, prev.t), cp = rawPath(dataDir, houseId, cur.kind, cur.t);
      if (!existsSync(pp) || !existsSync(cp)) continue;
      pair = newInPair(readRaw(pp), readRaw(cp));
      pairMemo.set(key, pair);
      if (pairMemo.size > PAIR_MEMO_MAX) pairMemo.delete(pairMemo.keys().next().value!);
    }
    read++;
    hoursByKind.set(cur.kind, (hoursByKind.get(cur.kind) ?? 0) + cur.h);
    for (const [item, prices] of pair) {
      let m = agg.get(item);
      if (!m) agg.set(item, (m = new Map()));
      for (const [p, u] of prices) m.set(p, (m.get(p) ?? 0) + u);
    }
  }
  if (!read) return null;
  const byItem = new Map<number, Array<[number, number]>>();
  for (const [item, m] of agg) byItem.set(item, [...m].sort((a, b) => a[0] - b[0]));
  const hours = Math.min(...['auctions', 'commodities'].map(k => hoursByKind.get(k) ?? 0));
  return { hours, byItem };
}
