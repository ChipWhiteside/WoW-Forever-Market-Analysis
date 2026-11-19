import type { DB } from '../store/db.ts';
import type { Faction } from '../rules/fees.ts';
import { marketPrice, priceGates } from '../rules/price.ts';
import { demandByItem } from './history.ts';

export type PriceBasis = 'sold' | 'market';

export interface PriceBook {
  houseId: number | null; faction: Faction; houseName: string;
  /**
   * The TRUSTED price per item on the house, not the raw cheapest listing: what it sold for recently when there are
   * enough sales, else the trimmed market price of the cheapest units. Items whose only price is junk (a troll listing
   * on a common or vendor item with no sales behind it, or a lone listing with no sales) are left out, and listed in `unproven`.
   */
  floor: Map<number, { floor: number; units: number; at: number; basis?: PriceBasis; listed?: number }>;
  unproven?: Map<number, { listed: number; reason: string }>;
  sell: Map<number, number>; binding: Map<number, string | null>; names: Map<number, string>;
  vendor: Map<number, { price: number; npc: string; zone: string | null }>;
}

/** The house prices are read from: the pinned Alliance house, else the busiest tracked Alliance house. */
export function primaryHouse(db: DB): { id: number; name: string; faction: Faction } | null {
  const pinned = db.prepare(`SELECT id, name, faction FROM houses WHERE pinned = 1 AND faction = 'alliance'`).get() as { id: number; name: string; faction: Faction } | undefined;
  if (pinned) return pinned;
  return (db.prepare(`SELECT h.id, h.name, h.faction FROM houses h JOIN snapshots s ON s.house_id = h.id WHERE h.faction = 'alliance' AND h.tracked = 1
    GROUP BY h.id ORDER BY MAX(s.rows) DESC LIMIT 1`).get() as { id: number; name: string; faction: Faction } | undefined) ?? null;
}

/** Latest floor per item on one house, plus vendor sell prices, cheapest Alliance usable vendor and names. */
export function priceBook(db: DB, house = primaryHouse(db)): PriceBook {
  const floor = new Map<number, { floor: number; units: number; at: number; basis?: PriceBasis; listed?: number }>();
  const unproven = new Map<number, { listed: number; reason: string }>();
  const rows = house ? db.prepare(`SELECT s.item_id, s.floor, s.total_units, s.listings, s.ladder, s.published_at FROM item_stats s
      JOIN (SELECT kind, MAX(published_at) t FROM snapshots WHERE house_id = ? GROUP BY kind) l
      JOIN snapshots sn ON sn.id = s.snapshot_id AND sn.kind = l.kind AND sn.published_at = l.t AND sn.house_id = ?
      WHERE s.floor IS NOT NULL`).all(house.id, house.id) as Array<{ item_id: number; floor: number; total_units: number; listings: number; ladder: string; published_at: number }> : [];
  const sell = new Map<number, number>(), binding = new Map<number, string | null>(), names = new Map<number, string>();
  for (const r of db.prepare('SELECT id, name, sell_price, binding FROM items').all() as Array<{ id: number; name: string | null; sell_price: number | null; binding: string | null }>) {
    if (r.sell_price != null) sell.set(r.id, r.sell_price);
    binding.set(r.id, r.binding);
    if (r.name) names.set(r.id, r.name);
  }
  const vendor = new Map<number, { price: number; npc: string; zone: string | null }>();
  for (const r of db.prepare(`SELECT item_id, MIN(price) price, npc_name, zone FROM vendor_items WHERE faction IN ('alliance', 'neutral') AND price > 0 GROUP BY item_id`).all() as Array<{ item_id: number; price: number; npc_name: string; zone: string | null }>) {
    vendor.set(r.item_id, { price: r.price, npc: r.npc_name, zone: r.zone });
  }
  const quality = new Map((db.prepare('SELECT id, quality FROM items').all() as Array<{ id: number; quality: string | null }>).map(r => [r.id, r.quality]));
  const demand = house ? demandByItem(db, house.id) : new Map();
  for (const r of rows) {
    const ladder = (JSON.parse(r.ladder) as Array<[number, number]>).map(([p, u]) => ({ unitPrice: p, quantity: u }));
    const m = marketPrice(ladder);
    const d = demand.get(r.item_id);
    const recent = (d?.recentSales ?? 0) >= 3 ? d?.recentSoldPrice ?? null : null;
    const sales = d ? Math.round((d.unitsPerDay * d.hours) / 24) : 0;
    const sold = recent ?? (sales >= 3 ? d?.soldPrice ?? null : null);
    // The trimmed price of the cheapest 15 to 30 percent of units: what buying or selling a few stacks really costs.
    const market = m?.price ?? r.floor;
    const price = sold != null ? Math.min(market, sold) : market;
    const gates = priceGates({ hours: d?.hours ?? 0, listings: r.listings, provenSales: sales, soldPrice: sold, askPrice: price, quality: quality.get(r.item_id) ?? null,
      vendorSell: sell.get(r.item_id) ?? null, vendorBuy: vendor.get(r.item_id)?.price ?? null });
    if (gates.length) { unproven.set(r.item_id, { listed: r.floor, reason: gates[0]! }); continue; }
    if (r.listings < 3 && sold == null) { unproven.set(r.item_id, { listed: r.floor, reason: `only ${r.listings} listing${r.listings === 1 ? '' : 's'} and no sales seen` }); continue; }
    floor.set(r.item_id, { floor: price, units: r.total_units, at: r.published_at, basis: sold != null ? 'sold' : 'market', listed: r.floor });
  }
  return { houseId: house?.id ?? null, faction: house?.faction ?? 'alliance', houseName: house?.name ?? 'no house yet', floor, unproven, sell, binding, names, vendor };
}
