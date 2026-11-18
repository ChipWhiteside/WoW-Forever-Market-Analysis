import type { BlizzardClient } from '../blizzard/client.ts';
import { HouseResponse, CommoditiesResponse } from '../blizzard/contracts.ts';
import { aggregate, fromAuctionRows, fromCommodityRows, type Listing, type ItemStat } from '../analysis/aggregate.ts';
import { type DB, tx } from '../store/db.ts';
import { rawPath, writeRaw, readRaw } from './rawstore.ts';
import { RULESET, type HouseRow } from './houses.ts';
import { existsSync } from 'node:fs';

export type Kind = 'auctions' | 'commodities';
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

interface Cursor { lastModified: string | null; listings: Listing[] | null }

/**
 * Polls one house and kind. A 304 costs nothing. A 200 with a new Last-Modified is a publish:
 * it is validated, stored raw, aggregated against the previous publish and written in one transaction.
 */
export class Collector {
  private cursors = new Map<string, Cursor>();

  constructor(private client: BlizzardClient, private db: DB, private dataDir: string) {}

  private key(h: number, k: Kind) { return `${h}:${k}`; }

  /** Restore the last publish per house and kind so differencing survives a restart. */
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
    const stats = aggregate(listings, cur.listings);
    const raw = rawPath(this.dataDir, house.id, kind, publishedAt);
    const bytes = writeRaw(raw, listings);

    const snapshotId = tx(this.db, () => {
      const ins = this.db.prepare(`INSERT OR IGNORE INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(house.id, kind, lastModified, publishedAt, Date.now(), listings.length,
        stats.filter(s => s.listings > 0).length, bytes, raw);
      const id = Number(ins.lastInsertRowid);
      const st = this.db.prepare(`INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5,
        total_units, listings, ladder, gone_listings, gone_units, gone_units_expiring, gone_units_near_floor, new_units)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const s of stats) {
        st.run(id, house.id, s.itemId, publishedAt, s.floor, s.unitsAtFloor, s.unitsWithin5, s.totalUnits, s.listings,
          JSON.stringify(s.ladder), s.goneListings, s.goneUnits, s.goneUnitsExpiring, s.goneUnitsNearFloor, s.newUnits);
      }
      return id;
    });

    this.cursors.set(k, { lastModified, listings });
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
