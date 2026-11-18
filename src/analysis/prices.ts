import type { DB } from '../store/db.ts';
import type { Faction } from '../rules/fees.ts';

export interface PriceBook {
  houseId: number | null; faction: Faction; houseName: string;
  floor: Map<number, { floor: number; units: number; at: number }>;
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
  const floor = new Map<number, { floor: number; units: number; at: number }>();
  if (house) {
    const rows = db.prepare(`SELECT s.item_id, s.floor, s.total_units, s.published_at FROM item_stats s
      JOIN (SELECT kind, MAX(published_at) t FROM snapshots WHERE house_id = ? GROUP BY kind) l
      JOIN snapshots sn ON sn.id = s.snapshot_id AND sn.kind = l.kind AND sn.published_at = l.t AND sn.house_id = ?
      WHERE s.floor IS NOT NULL`).all(house.id, house.id) as Array<{ item_id: number; floor: number; total_units: number; published_at: number }>;
    for (const r of rows) floor.set(r.item_id, { floor: r.floor, units: r.total_units, at: r.published_at });
  }
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
  return { houseId: house?.id ?? null, faction: house?.faction ?? 'alliance', houseName: house?.name ?? 'no house yet', floor, sell, binding, names, vendor };
}
