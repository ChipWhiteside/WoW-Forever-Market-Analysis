import { netPerUnit, listingPlan } from '../rules/fees.ts';
import { SELL_NOW } from '../rules/thresholds.ts';
import { byItem, auctionLeg, realisticUnits, DEFAULT_SELL_SHARE, type DetectorContext, type Play, type Leg } from './types.ts';
import type { Typical } from '../analysis/history.ts';
import { AUCTION_HOUSES } from '../datasets/places.ts';
import { playLine } from './summary.ts';

export interface Held { itemId: number; units: number; unitCost: number | null; alertAbove: number | null }

/**
 * O6 Sell what you hold. Something Chip holds or watches jumped: the floor sits 50 percent above its typical floor,
 * or crosses a price he set. Profit per item = the floor after the cut minus what he paid.
 */
export function sellNow(ctx: DetectorContext, typical: Map<number, Map<number, Typical>>, held: Held[]): Play[] {
  const plays: Play[] = [];
  const share = ctx.sellShare ?? DEFAULT_SELL_SHARE;
  for (const h of ctx.houses) {
    const floors = byItem(ctx.listings.get(h.id) ?? []);
    for (const x of held) {
      const ls = floors.get(x.itemId);
      if (!ls?.length) continue;
      const floor = ls[0]!.unitPrice!;
      const t = typical.get(h.id)?.get(x.itemId);
      const jumped = t && floor >= t.typicalFloor * (1 + SELL_NOW.aboveTypical);
      const crossed = x.alertAbove != null && floor >= x.alertAbove;
      if (!jumped && !crossed) continue;
      const item = ctx.items.get(x.itemId);
      const net = netPerUnit(h.faction, floor);
      const perItem = net - (x.unitCost ?? 0);
      const d = ctx.demand.get(h.id)?.get(x.itemId);
      const salesPerDay = d && d.hours >= 3 ? d.unitsPerDay : null;
      const units = x.units > 0 ? realisticUnits(x.units, salesPerDay, share) : 1;
      const buy: Leg = { kind: 'held', price: x.unitCost ?? 0, who: x.units ? `You hold ${x.units}` : 'On your watchlist', places: [] };
      const sell = { ...auctionLeg(h, net, AUCTION_HOUSES[h.faction === 'blackwater' ? 'blackwater' : 'alliance']),
        note: (t ? `${Math.round((floor / t.typicalFloor - 1) * 100)}% over its typical ${t.typicalFloor}c` : '') + (crossed ? `${t ? ', ' : ''}past your ${x.alertAbove}c alert` : '') };
      const name = item?.name ?? `Item ${x.itemId}`;
      plays.push({
        key: `sell_now:${h.id}:${x.itemId}`, detector: 'sell_now', houseId: h.id, itemId: x.itemId, profit: perItem * units, confidence: 'high',
        summary: playLine(name, perItem, buy, sell, salesPerDay),
        detail: { buy, sell, perItem, salesPerDay, available: x.units, realisticUnits: units, floor, typicalFloor: t?.typicalFloor ?? null,
          listing: listingPlan(h.faction, item?.sellPrice, perItem, salesPerDay == null ? null : (salesPerDay * share) / 24, units) },
        dataAt: h.publishedAt,
      });
    }
  }
  return plays;
}

/** Open positions plus the watchlist, merged per item. */
export function heldItems(db: import('../store/db.ts').DB): Held[] {
  const m = new Map<number, Held>();
  for (const p of db.prepare(`SELECT item_id, SUM(quantity - COALESCE(sold_qty, 0)) units, CAST(SUM(unit_cost * (quantity - COALESCE(sold_qty, 0))) / MAX(1, SUM(quantity - COALESCE(sold_qty, 0))) AS INTEGER) cost
      FROM positions WHERE closed_at IS NULL GROUP BY item_id`).all() as Array<{ item_id: number; units: number; cost: number }>) {
    m.set(p.item_id, { itemId: p.item_id, units: p.units, unitCost: p.cost, alertAbove: null });
  }
  for (const w of db.prepare('SELECT item_id, alert_above FROM watchlist').all() as Array<{ item_id: number; alert_above: number | null }>) {
    const e = m.get(w.item_id) ?? { itemId: w.item_id, units: 0, unitCost: null, alertAbove: null };
    e.alertAbove = w.alert_above; m.set(w.item_id, e);
  }
  return [...m.values()];
}
