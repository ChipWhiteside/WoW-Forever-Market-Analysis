import type { DB } from '../store/db.ts';
import type { Collector } from './collector.ts';
import type { DetectorContext, HouseCtx, ItemCtx, VendorOffer } from '../detectors/types.ts';
import type { Listing } from '../analysis/aggregate.ts';
import { demandByItem } from '../analysis/history.ts';
import { trackedHouses } from './houses.ts';

/** Latest publish time per house across both kinds. */
export function lastPublish(db: DB): Map<number, number> {
  const rows = db.prepare('SELECT house_id, MAX(published_at) t FROM snapshots GROUP BY house_id').all() as Array<{ house_id: number; t: number }>;
  return new Map(rows.map(r => [r.house_id, r.t]));
}

export function itemsFor(db: DB, ids: Iterable<number>): Map<number, ItemCtx> {
  const out = new Map<number, ItemCtx>();
  const q = db.prepare('SELECT id, name, sell_price, binding, quality FROM items WHERE id = ?');
  for (const id of ids) {
    const r = q.get(id) as { id: number; name: string | null; sell_price: number | null; binding: string | null; quality: string | null } | undefined;
    if (r) out.set(id, { id, name: r.name ?? `Item ${id}`, sellPrice: r.sell_price, binding: r.binding, quality: r.quality });
  }
  return out;
}

/** Vendors an Alliance character can use: Alliance and neutral. Unknown faction is never treated as usable (T4). */
export function allianceVendors(db: DB): Map<number, VendorOffer[]> {
  const rows = db.prepare(`SELECT npc_id, npc_name, faction, zone, x, y, map_id, item_id, price, limited, standing_required FROM vendor_items WHERE faction IN ('alliance', 'neutral') AND price > 0`).all() as Array<{
    npc_id: number; npc_name: string; faction: string; zone: string | null; x: number | null; y: number | null; map_id: number | null; item_id: number; price: number; limited: number; standing_required: string | null }>;
  const out = new Map<number, VendorOffer[]>();
  for (const r of rows) {
    let a = out.get(r.item_id);
    if (!a) out.set(r.item_id, (a = []));
    a.push({ npcId: r.npc_id, npcName: r.npc_name, faction: r.faction, zone: r.zone, x: r.x, y: r.y, uiMap: r.map_id, unitPrice: r.price, limited: !!r.limited, minStanding: Number(r.standing_required ?? 4) });
  }
  return out;
}

export function buildContext(db: DB, collector: Collector, now = Date.now()): DetectorContext {
  const pubs = lastPublish(db);
  const houses: HouseCtx[] = [];
  const listings = new Map<number, Listing[]>();
  const ids = new Set<number>();
  for (const h of trackedHouses(db)) {
    const ls = [...collector.listings(h.id, 'auctions'), ...collector.listings(h.id, 'commodities')];
    if (ls.length === 0) continue;
    houses.push({ id: h.id, name: h.name, faction: h.faction, cut: h.cut, pinned: !!h.pinned, publishedAt: pubs.get(h.id) ?? now });
    listings.set(h.id, ls);
    for (const l of ls) ids.add(l.itemId);
  }
  const demand = new Map(houses.map(h => [h.id, demandByItem(db, h.id, { now })]));
  const share = Number((db.prepare(`SELECT value FROM settings WHERE key = 'sell_share'`).get() as { value: string } | undefined)?.value ?? 0.2);
  return { houses, listings, items: itemsFor(db, ids), vendors: allianceVendors(db), demand, now, sellShare: share > 0 && share <= 1 ? share : 0.2 };
}
