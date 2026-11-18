/**
 * Turn one snapshot of listings into per item market stats, and difference it
 * against the previous snapshot of the same house and kind.
 *
 * Ledger rules applied here:
 *  - Equipment: buyout is the unit price (quantity is always 1, V13). Divided anyway, defensively.
 *  - Commodities: unit_price is already per unit (V4).
 *  - Bid only listings never set a floor.
 *  - Sell through comes from strict listing id set differences, never row counts (rule 4).
 */

export interface Listing {
  id: number;
  itemId: number;
  quantity: number;
  /** copper per unit, null for bid only */
  unitPrice: number | null;
  timeLeft: 'SHORT' | 'MEDIUM' | 'LONG' | 'VERY_LONG';
}

export interface ItemStat {
  itemId: number;
  floor: number | null;
  unitsAtFloor: number;
  unitsWithin5: number;
  totalUnits: number;
  listings: number;
  /** cheapest price points, [unitPrice, units] */
  ladder: Array<[number, number]>;
  goneListings: number | null;
  goneUnits: number | null;
  goneUnitsExpiring: number | null;
  goneUnitsNearFloor: number | null;
  newUnits: number | null;
}

export const LADDER_POINTS = 12;

export function fromAuctionRows(rows: Array<{ id: number; item: { id: number }; buyout?: number; quantity: number; time_left: Listing['timeLeft'] }>): Listing[] {
  return rows.map(r => ({
    id: r.id,
    itemId: r.item.id,
    quantity: r.quantity,
    unitPrice: r.buyout != null && r.buyout > 0 ? Math.floor(r.buyout / r.quantity) : null,
    timeLeft: r.time_left,
  }));
}

export function fromCommodityRows(rows: Array<{ id: number; item: { id: number }; unit_price: number; quantity: number; time_left: Listing['timeLeft'] }>): Listing[] {
  return rows.map(r => ({ id: r.id, itemId: r.item.id, quantity: r.quantity, unitPrice: r.unit_price, timeLeft: r.time_left }));
}

export function aggregate(current: Listing[], previous: Listing[] | null): ItemStat[] {
  const byItem = new Map<number, Listing[]>();
  for (const l of current) {
    let arr = byItem.get(l.itemId);
    if (!arr) byItem.set(l.itemId, (arr = []));
    arr.push(l);
  }

  // Previous snapshot, indexed for the strict id set difference.
  let prevById: Map<number, Listing> | null = null;
  let prevFloor: Map<number, number> | null = null;
  const curIds = new Set(current.map(l => l.id));
  if (previous) {
    prevById = new Map(previous.map(l => [l.id, l]));
    prevFloor = new Map();
    for (const l of previous) {
      if (l.unitPrice == null) continue;
      const f = prevFloor.get(l.itemId);
      if (f == null || l.unitPrice < f) prevFloor.set(l.itemId, l.unitPrice);
    }
  }

  const gone = new Map<number, { listings: number; units: number; expiring: number; nearFloor: number }>();
  if (prevById) {
    for (const [id, l] of prevById) {
      if (curIds.has(id)) continue;
      let g = gone.get(l.itemId);
      if (!g) gone.set(l.itemId, (g = { listings: 0, units: 0, expiring: 0, nearFloor: 0 }));
      g.listings++;
      g.units += l.quantity;
      if (l.timeLeft === 'SHORT') g.expiring += l.quantity;
      const pf = prevFloor!.get(l.itemId);
      if (pf != null && l.unitPrice != null && l.unitPrice <= pf * 1.1) g.nearFloor += l.quantity;
    }
  }

  const out: ItemStat[] = [];
  const itemIds = new Set<number>([...byItem.keys(), ...gone.keys()]);
  for (const itemId of itemIds) {
    const ls = byItem.get(itemId) ?? [];
    let floor: number | null = null;
    let totalUnits = 0;
    const points = new Map<number, number>();
    for (const l of ls) {
      totalUnits += l.quantity;
      if (l.unitPrice == null) continue;
      if (floor == null || l.unitPrice < floor) floor = l.unitPrice;
      points.set(l.unitPrice, (points.get(l.unitPrice) ?? 0) + l.quantity);
    }
    const ladder = [...points.entries()].sort((a, b) => a[0] - b[0]);
    let unitsWithin5 = 0;
    if (floor != null) for (const [p, u] of ladder) if (p <= floor * 1.05) unitsWithin5 += u;
    let newUnits: number | null = null;
    if (prevById) {
      newUnits = 0;
      for (const l of ls) if (!prevById.has(l.id)) newUnits += l.quantity;
    }
    const g = gone.get(itemId);
    out.push({
      itemId,
      floor,
      unitsAtFloor: floor == null ? 0 : points.get(floor) ?? 0,
      unitsWithin5,
      totalUnits,
      listings: ls.length,
      ladder: ladder.slice(0, LADDER_POINTS),
      goneListings: prevById ? g?.listings ?? 0 : null,
      goneUnits: prevById ? g?.units ?? 0 : null,
      goneUnitsExpiring: prevById ? g?.expiring ?? 0 : null,
      goneUnitsNearFloor: prevById ? g?.nearFloor ?? 0 : null,
      newUnits,
    });
  }
  return out;
}
