import { money } from '../format/money.ts';
import { netPerUnit } from '../rules/fees.ts';
import { UNDERPRICED } from '../rules/thresholds.ts';
import { byItem, type DetectorContext, type Play } from './types.ts';
import type { Typical } from '../analysis/history.ts';

/**
 * O3 Underpriced listing. The floor sits at least 30 percent under the typical floor, on an item that
 * actually sells (at least 3 units vanished near the floor before expiring in the window).
 * Profit available: for every cheap listing, the typical floor after the cut minus its price, capped at a day of demand.
 */
export function underpriced(ctx: DetectorContext, typical: Map<number, Map<number, Typical>>): Play[] {
  const plays: Play[] = [];
  for (const h of ctx.houses) {
    const tf = typical.get(h.id);
    if (!tf?.size) continue;
    for (const [itemId, ls] of byItem(ctx.listings.get(h.id) ?? [])) {
      const t = tf.get(itemId);
      if (!t) continue;
      const item = ctx.items.get(itemId);
      if (item?.binding === 'ON_ACQUIRE') continue;
      const line = t.typicalFloor * (1 - UNDERPRICED.belowTypical);
      if (ls[0]!.unitPrice! > line) continue;
      const d = ctx.demand.get(h.id)?.get(itemId);
      const soldInWindow = d ? (d.unitsPerDay * d.hours) / 24 : 0;
      if (soldInWindow < UNDERPRICED.minDisappeared) continue;
      const net = netPerUnit(h.faction, t.typicalFloor, item?.sellPrice);
      let cap = Math.max(1, Math.round(d!.unitsPerDay));
      let profit = 0, units = 0;
      for (const l of ls) {
        if (l.unitPrice! > line || cap <= 0) break;
        const q = Math.min(l.quantity, cap);
        profit += (net - l.unitPrice!) * q; units += q; cap -= q;
      }
      if (profit <= 0) continue;
      const name = item?.name ?? `Item ${itemId}`;
      const pct = Math.round((1 - ls[0]!.unitPrice! / t.typicalFloor) * 100);
      plays.push({
        key: `underpriced:${h.id}:${itemId}`,
        detector: 'underpriced', houseId: h.id, itemId, profit,
        confidence: 'medium',
        summary: `${name} is listed at ${money(ls[0]!.unitPrice)} on ${h.name}, ${pct}% under its typical ${money(t.typicalFloor)}. Buy the cheap units and relist near ${money(t.typicalFloor)}, about ${money(profit)} after the cut.`,
        detail: { floor: ls[0]!.unitPrice, typicalFloor: t.typicalFloor, readings: t.readings, units, demandPerDay: d!.unitsPerDay, oneOff: ls.filter(l => l.unitPrice! <= line).length === 1 },
        dataAt: h.publishedAt,
      });
    }
  }
  return plays;
}
