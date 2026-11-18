import { money } from '../format/money.ts';
import { netPerUnit } from '../rules/fees.ts';
import { SELL_NOW } from '../rules/thresholds.ts';
import { byItem, houseLabel, plural, type DetectorContext, type Play } from './types.ts';
import type { Typical } from '../analysis/history.ts';

export interface Held { itemId: number; units: number; unitCost: number | null; alertAbove: number | null }

/**
 * O6 Sell now. Something Chip holds or watches jumped: the floor sits 50 percent above its typical floor,
 * or crosses a price he set. Profit available is his held units times (net price now minus what he paid).
 */
export function sellNow(ctx: DetectorContext, typical: Map<number, Map<number, Typical>>, held: Held[]): Play[] {
  const plays: Play[] = [];
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
      const net = netPerUnit(h.faction, floor, item?.sellPrice);
      const profit = x.units > 0 ? x.units * (net - (x.unitCost ?? 0)) : net;
      const name = item?.name ?? `Item ${x.itemId}`;
      plays.push({
        key: `sell_now:${h.id}:${x.itemId}`, detector: 'sell_now', houseId: h.id, itemId: x.itemId, profit,
        confidence: 'high',
        summary: `${name} floor is ${money(floor)} on ${houseLabel(h)}` + (t ? `, ${Math.round((floor / t.typicalFloor - 1) * 100)}% over its typical ${money(t.typicalFloor)}` : '') +
          (crossed ? `, past your ${money(x.alertAbove)} alert` : '') + (x.units ? `. You hold ${x.units}.` : '.'),
        detail: { floor, typicalFloor: t?.typicalFloor ?? null, held: x.units, unitCost: x.unitCost, net },
        dataAt: h.publishedAt,
      });
    }
  }
  return plays;
}

/** Open positions plus the watchlist, merged per item. */
export function heldItems(db: import('../store/db.ts').DB): Held[] {
  const m = new Map<number, Held>();
  for (const p of db.prepare(`SELECT item_id, SUM(quantity - COALESCE(sold_qty, 0)) units, CAST(SUM(unit_cost * quantity) / MAX(1, SUM(quantity)) AS INTEGER) cost
      FROM positions WHERE closed_at IS NULL GROUP BY item_id`).all() as Array<{ item_id: number; units: number; cost: number }>) {
    m.set(p.item_id, { itemId: p.item_id, units: p.units, unitCost: p.cost, alertAbove: null });
  }
  for (const w of db.prepare('SELECT item_id, alert_above FROM watchlist').all() as Array<{ item_id: number; alert_above: number | null }>) {
    const e = m.get(w.item_id) ?? { itemId: w.item_id, units: 0, unitCost: null, alertAbove: null };
    e.alertAbove = w.alert_above; m.set(w.item_id, e);
  }
  return [...m.values()];
}
