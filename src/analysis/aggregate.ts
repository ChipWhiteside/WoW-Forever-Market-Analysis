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
  /** of goneUnitsNearFloor, ones that were most likely NOT sales: they could have expired (SHORT or MEDIUM time
   * left, since snapshots are about an hour apart), or a matching listing reappeared (cancel and relist) */
  goneUnitsExpiringNearFloor: number | null;
  /** copper value of the near floor units judged sold, so demand carries the price it happened at */
  soldValue: number | null;
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

/**
 * `commodity`: stackables are bought through a window that always fills from the cheapest listing first, so a
 * stack that vanished while a cheaper one is still up was cancelled, never bought. Equipment buyers pick a
 * listing, so there a 25 percent margin applies.
 */
export function aggregate(current: Listing[], previous: Listing[] | null, opts: { commodity?: boolean } = {}): ItemStat[] {
  const survivorMargin = opts.commodity ? 1 : 1.25;
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

  const gone = new Map<number, { listings: number; units: number; expiring: number; nearFloor: number; expiringNear: number; soldValue: number }>();
  const curById = new Map(current.map(l => [l.id, l]));
  // Thin markets only (5 listings or fewer last time): a vanished listing with a new one of the same size and
  // about the same price is a cancel and relist, not a sale. Deep markets restock constantly, so matching there
  // would erase real sales.
  const prevCount = new Map<number, number>();
  if (prevById) for (const l of prevById.values()) prevCount.set(l.itemId, (prevCount.get(l.itemId) ?? 0) + 1);
  const relistPool = new Map<number, Listing[]>();
  if (prevById) for (const l of current) if (!prevById.has(l.id) && (prevCount.get(l.itemId) ?? 0) <= 5) {
    const a = relistPool.get(l.itemId) ?? []; a.push(l); relistPool.set(l.itemId, a);
  }
  const takeRelist = (l: Listing): boolean => {
    const pool = relistPool.get(l.itemId);
    if (!pool || l.unitPrice == null) return false;
    const i = pool.findIndex(n => n.quantity === l.quantity && n.unitPrice != null && Math.abs(n.unitPrice - l.unitPrice!) <= l.unitPrice! * 0.25);
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  };
  // Cheapest listing that is still up now, per item. Buyers take the cheapest first, so a listing that vanished
  // while it was priced over 1.25 times a cheaper surviving one was most likely cancelled, not bought.
  const curFloor = new Map<number, number>();
  for (const l of current) if (l.unitPrice != null && (prevById?.has(l.id) ?? false)) {
    const f = curFloor.get(l.itemId); if (f == null || l.unitPrice < f) curFloor.set(l.itemId, l.unitPrice);
  }
  if (prevById) {
    for (const [id, l] of prevById) {
      // A listing that vanished, or a stack that shrank (a partial buy of a commodity listing), lost units.
      const still = curIds.has(id) ? curById.get(id)! : null;
      const lost = still ? Math.max(0, l.quantity - still.quantity) : l.quantity;
      if (lost === 0) continue;
      let g = gone.get(l.itemId);
      if (!g) gone.set(l.itemId, (g = { listings: 0, units: 0, expiring: 0, nearFloor: 0, expiringNear: 0, soldValue: 0 }));
      if (!still) g.listings++;
      g.units += lost;
      // Snapshots are about an hour apart, so anything that showed under 2 hours left may simply have expired.
      const expiring = !still && (l.timeLeft === 'SHORT' || l.timeLeft === 'MEDIUM');
      if (expiring) g.expiring += lost;
      const survivor = curFloor.get(l.itemId);
      const pricedAboveSurvivor = !still && survivor != null && l.unitPrice != null && l.unitPrice > survivor * survivorMargin;
      const notSale = expiring || pricedAboveSurvivor || (!still && takeRelist(l));
      const pf = prevFloor!.get(l.itemId);
      if (pf != null && l.unitPrice != null && l.unitPrice <= pf * 1.1) {
        g.nearFloor += lost;
        if (notSale) g.expiringNear += lost; else g.soldValue += lost * l.unitPrice;
      }
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
      goneUnitsExpiringNearFloor: prevById ? g?.expiringNear ?? 0 : null,
      soldValue: prevById ? g?.soldValue ?? 0 : null,
      newUnits,
    });
  }
  return out;
}
