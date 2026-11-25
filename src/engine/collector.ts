import type { BlizzardClient } from '../blizzard/client.ts';
import { HouseResponse, CommoditiesResponse } from '../blizzard/contracts.ts';
import { aggregate, fromAuctionRows, fromCommodityRows, nextSeen, type Listing, type ItemStat, type Seen, type TimeLeft, type OwnTrades, type Diagnostics } from '../analysis/aggregate.ts';
import { type DB, tx, getKv, setKv } from '../store/db.ts';
import { rawPath, writeRaw, readRaw } from './rawstore.ts';
import { RULESET, type HouseRow } from './houses.ts';
import { existsSync } from 'node:fs';

export type Kind = 'auctions' | 'commodities';
/** Longest gap between publishes that still counts as one differencing step. Blizzard publishes about hourly. */
export const MAX_DIFF_HOURS = 1.6;
export const KINDS: Kind[] = ['auctions', 'commodities'];

export interface SnapshotEvent {
  snapshotId: number;
  house: HouseRow;
  kind: Kind;
  publishedAt: number;
  rows: number;
  stats: ItemStat[];
  suspect: string[];
}

/** `seen`: first sight of every listing in `listings`; undefined until loaded from listing_seen on the first poll. */
interface Cursor { lastModified: string | null; listings: Listing[] | null; seen?: Map<number, Seen> }

const H = 3600_000;

/**
 * Chip's own trades, so his buys never count as market demand and his posts never as competing ones.
 * HOOK: no data source fills this yet. Settings key `own_trade_listing_ids` holds a JSON array of auction ids
 * (listings Chip posted or bought). A mailbox or addon import can write it later.
 */
export function ownTrades(db: DB): OwnTrades | undefined {
  const r = db.prepare(`SELECT value FROM settings WHERE key = 'own_trade_listing_ids'`).get() as { value: string } | undefined;
  if (!r) return undefined;
  try {
    const ids = JSON.parse(r.value) as unknown;
    return Array.isArray(ids) ? { listingIds: new Set(ids.map(Number).filter(Number.isFinite)) } : undefined;
  } catch { return undefined; }
}

/** kv key: first sights at or before this publish time are of unknown age (they were seeded, not seen appear). */
const seenSinceKey = (houseId: number, kind: string) => `listing_seen_since:${houseId}:${kind}`;

/**
 * Listing first sights for one house and kind, from table listing_seen. Whether the age is known is not stored:
 * it is known when the first sight came from a differenced publish (diff_hours set) after the seeding time.
 */
export function loadSeen(db: DB, houseId: number, kind: string): Map<number, Seen> {
  const since = Number(getKv(db, seenSinceKey(houseId, kind)) ?? 0);
  const diff = new Map((db.prepare('SELECT published_at, diff_hours FROM snapshots WHERE house_id = ? AND kind = ?').all(houseId, kind) as Array<{ published_at: number; diff_hours: number | null }>)
    .map(r => [r.published_at, r.diff_hours]));
  const rows = db.prepare('SELECT listing_id, first_seen, first_time_left FROM listing_seen WHERE house_id = ? AND kind = ?').all(houseId, kind) as Array<{ listing_id: number; first_seen: number; first_time_left: string }>;
  const shared = new Map<string, Seen>();
  const out = new Map<number, Seen>();
  for (const r of rows) {
    const d = diff.get(r.first_seen);
    const postedAfter = r.first_seen > since && d != null ? r.first_seen - Math.round(d * H) : null;
    const key = `${r.first_seen}:${r.first_time_left}:${postedAfter}`;
    let s = shared.get(key);
    if (!s) shared.set(key, (s = { firstSeen: r.first_seen, firstTimeLeft: r.first_time_left as TimeLeft, postedAfter }));
    out.set(r.listing_id, s);
  }
  return out;
}

/** Write the change between two first sight maps (or the whole map when `before` is null). Call inside a transaction. */
export function saveSeen(db: DB, houseId: number, kind: string, before: Map<number, Seen> | null, after: Map<number, Seen>, items: Map<number, number>): void {
  const ins = db.prepare('INSERT OR REPLACE INTO listing_seen (house_id, kind, listing_id, item_id, first_seen, first_time_left) VALUES (?, ?, ?, ?, ?, ?)');
  if (!before) {
    db.prepare('DELETE FROM listing_seen WHERE house_id = ? AND kind = ?').run(houseId, kind);
    for (const [id, s] of after) ins.run(houseId, kind, id, items.get(id) ?? 0, s.firstSeen, s.firstTimeLeft);
    return;
  }
  const del = db.prepare('DELETE FROM listing_seen WHERE house_id = ? AND kind = ? AND listing_id = ?');
  for (const id of before.keys()) if (!after.has(id)) del.run(houseId, kind, id);
  for (const [id, s] of after) if (before.get(id) !== s) ins.run(houseId, kind, id, items.get(id) ?? 0, s.firstSeen, s.firstTimeLeft);
}

export function markSeenSince(db: DB, houseId: number, kind: string, at: number): void {
  setKv(db, seenSinceKey(houseId, kind), String(at));
}

/**
 * Whether item_stats has a sold_events column. It is not in the schema yet (it needs a migration in the protected
 * src/store/db.ts); until it is, the count of sale events is not stored and demand falls back to a cruder count.
 */
export function hasSoldEvents(db: DB): boolean {
  return (db.prepare(`SELECT COUNT(*) n FROM pragma_table_info('item_stats') WHERE name = 'sold_events'`).get() as { n: number }).n > 0;
}

/** INSERT for one item_stats row, with sold_events when the column exists. Arguments in the order of `itemStatValues`. */
export function itemStatsInsert(db: DB): ReturnType<DB['prepare']> {
  const ev = hasSoldEvents(db);
  return db.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5,
    total_units, listings, ladder, gone_listings, gone_units, gone_units_expiring, gone_units_near_floor, new_units, gone_units_expiring_near_floor, sold_value,
    sold_units, sweep_high, new_near_floor${ev ? ', sold_events' : ''})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${ev ? ', ?' : ''})`);
}
export function itemStatValues(snapshotId: number, houseId: number, publishedAt: number, s: ItemStat, withEvents: boolean): Array<string | number | null> {
  const v: Array<string | number | null> = [snapshotId, houseId, s.itemId, publishedAt, s.floor, s.unitsAtFloor, s.unitsWithin5, s.totalUnits, s.listings,
    JSON.stringify(s.ladder), s.goneListings, s.goneUnits, s.goneUnitsExpiring, s.goneUnitsNearFloor, s.newUnits, s.goneUnitsExpiringNearFloor, s.soldValue,
    s.soldUnits, s.sweepHigh, s.newNearFloor];
  if (withEvents) v.push(s.soldEvents);
  return v;
}

/** One suspect line per publish for sale bound breaches and age readings that contradict the bucket mapping. */
export function diagSuspects(houseId: number, kind: string, d: Diagnostics): string[] {
  const out: string[] = [];
  if (d.breaches.length) out.push(`house ${houseId} ${kind}: units judged sold exceeded what left the house on ${d.breaches.length} item${d.breaches.length === 1 ? '' : 's'} (${d.breaches.slice(0, 3).join('; ')})`);
  if (d.ageConflicts) out.push(`house ${houseId} ${kind}: ${d.ageConflicts} vanished listings had a time left that contradicts their age (check the time left mapping)`);
  return out;
}

/**
 * Polls one house and kind. A 304 costs nothing. A 200 with a new Last-Modified is a publish:
 * it is validated, stored raw, aggregated against the previous publish and written in one transaction.
 */
export class Collector {
  private cursors = new Map<string, Cursor>();

  constructor(private client: BlizzardClient, private db: DB, private dataDir: string) {}

  private key(h: number, k: Kind) { return `${h}:${k}`; }

  /** Restore the last publish per house and kind so differencing survives a restart. Listing ages load on the first poll,
   * after a history rebuild at start has had the chance to rewrite them. */
  restore(houseId: number, kind: Kind): void {
    const row = this.db.prepare('SELECT last_modified, raw_path FROM snapshots WHERE house_id = ? AND kind = ? ORDER BY published_at DESC LIMIT 1').get(houseId, kind) as { last_modified: string; raw_path: string | null } | undefined;
    if (!row) return;
    let listings: Listing[] | null = null;
    if (row.raw_path && existsSync(row.raw_path)) {
      try { listings = readRaw(row.raw_path); } catch { listings = null; }
    }
    this.cursors.set(this.key(houseId, kind), { lastModified: row.last_modified, listings });
  }

  async poll(house: HouseRow, kind: Kind): Promise<SnapshotEvent | null> {
    const k = this.key(house.id, kind);
    if (!this.cursors.has(k)) this.restore(house.id, kind);
    const cur = this.cursors.get(k) ?? { lastModified: null, listings: null };
    const path = `/data/wow/ruleset/${RULESET}/auctions/${house.id}` + (kind === 'commodities' ? '/commodities' : '');
    const started = Date.now();
    const schema = kind === 'commodities' ? CommoditiesResponse : HouseResponse;
    let res;
    try {
      res = await this.client.get(this.client.url(path, 'dynamic'), schema, { ifModifiedSince: cur.lastModified });
    } catch (err) {
      this.log(house.id, kind, -1, Date.now() - started, String((err as Error).message).slice(0, 300));
      throw err;
    }
    this.log(house.id, kind, res.status, res.ms, null);
    if (res.status === 304 || !res.body) return null;
    const lastModified = res.lastModified ?? new Date().toUTCString();
    if (lastModified === cur.lastModified) return null; // same publish served again

    const listings = kind === 'commodities'
      ? fromCommodityRows((res.body as { auctions: Parameters<typeof fromCommodityRows>[0] }).auctions)
      : fromAuctionRows(((res.body as { auctions?: Parameters<typeof fromAuctionRows>[0] }).auctions) ?? []);

    // Ledger rule 2: an empty result is a suspected bug until proven to be a market fact.
    const suspect: string[] = [];
    if (listings.length === 0) suspect.push(`house ${house.id} ${kind}: zero listings`);
    if (cur.listings && cur.listings.length > 1000 && listings.length < cur.listings.length * 0.5) {
      suspect.push(`house ${house.id} ${kind}: rows fell from ${cur.listings.length} to ${listings.length}`);
    }

    const publishedAt = Date.parse(lastModified) || Date.now();
    // Difference only against the publish right before this one. After a gap (PC off, a skipped publish)
    // vanished listings span many hours and would read as one hour of huge demand (review finding 1).
    const prevAt = cur.lastModified ? Date.parse(cur.lastModified) : NaN;
    const diffHours = Number.isFinite(prevAt) ? (publishedAt - prevAt) / 3600_000 : null;
    let diffable = !!cur.listings && diffHours != null && diffHours > 0 && diffHours <= MAX_DIFF_HOURS;
    // House guard: if over 30 percent of last hour's listings vanished at once, it is a reset or a gap, not trading.
    if (diffable && cur.listings!.length > 100) {
      const now = new Set(listings.map(l => l.id));
      let vanished = 0;
      for (const l of cur.listings!) if (!now.has(l.id)) vanished++;
      if (vanished / cur.listings!.length > 0.3) { diffable = false; suspect.push(`house ${house.id} ${kind}: ${Math.round(100 * vanished / cur.listings!.length)}% of listings vanished in one hour, not counted as sales`); }
    }
    // Listing ages: first sight of each listing, kept in listing_seen and pruned to the current listings.
    if (!cur.seen) cur.seen = loadSeen(this.db, house.id, kind);
    const seenBefore = cur.seen;
    const prevSnap = cur.listings && Number.isFinite(prevAt) ? { listings: cur.listings, at: prevAt } : null;
    const seeded = !!prevSnap && prevSnap.listings.some(l => !seenBefore.has(l.id));
    const seen = nextSeen(seenBefore, listings, publishedAt, prevSnap, diffable);
    const diag: Diagnostics = { ageConflicts: 0, breaches: [] };
    const stats = aggregate(listings, diffable ? cur.listings : null, {
      commodity: kind === 'commodities', prevAt: diffable ? prevAt : undefined, curAt: publishedAt, seen: seenBefore, own: ownTrades(this.db), diag,
    });
    suspect.push(...diagSuspects(house.id, kind, diag));
    const raw = rawPath(this.dataDir, house.id, kind, publishedAt);
    const bytes = writeRaw(raw, listings);

    const snapshotId = tx(this.db, () => {
      if (seeded) markSeenSince(this.db, house.id, kind, prevAt);
      saveSeen(this.db, house.id, kind, seenBefore.size ? seenBefore : null, seen, new Map(listings.map(l => [l.id, l.itemId])));
      const existing = this.db.prepare('SELECT id FROM snapshots WHERE house_id = ? AND kind = ? AND last_modified = ?').get(house.id, kind, lastModified) as { id: number } | undefined;
      if (existing) return existing.id; // same publish already stored, e.g. Last-Modified went backwards
      const ins = this.db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path, diff_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(house.id, kind, lastModified, publishedAt, Date.now(), listings.length,
        stats.filter(s => s.listings > 0).length, bytes, raw, diffable ? diffHours : null);
      const id = Number(ins.lastInsertRowid);
      const st = itemStatsInsert(this.db);
      const ev = hasSoldEvents(this.db);
      for (const s of stats) st.run(...itemStatValues(id, house.id, publishedAt, s, ev));
      return id;
    });

    this.cursors.set(k, { lastModified, listings, seen });
    return { snapshotId, house, kind, publishedAt, rows: listings.length, stats, suspect };
  }

  /** Current listings for a house and kind, as of the last publish seen. Used by detectors. */
  listings(houseId: number, kind: Kind): Listing[] {
    return this.cursors.get(this.key(houseId, kind))?.listings ?? [];
  }

  private log(houseId: number, kind: Kind, status: number, ms: number, note: string | null) {
    this.db.prepare('INSERT INTO poll_log (at, house_id, kind, status, ms, note) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), houseId, kind, status, ms, note);
  }
}
