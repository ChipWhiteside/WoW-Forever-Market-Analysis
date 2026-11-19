import { money } from '../format/money.ts';
import { netPerUnit, listingPlan } from '../rules/fees.ts';
import { UNDERPRICED } from '../rules/thresholds.ts';
import { byItem, auctionLeg, realisticUnits, judgeSell, DEFAULT_SELL_SHARE, type DetectorContext, type Play } from './types.ts';
import type { Typical } from '../analysis/history.ts';
import { AUCTION_HOUSES } from '../datasets/places.ts';
import { playLine } from './summary.ts';

/**
 * O3 Cheap listing, relist. The floor sits at least 30 percent under the typical floor, on an item that actually
 * sells. Profit per item = the typical floor after the cut minus the average cheap price.
 */
export function underpriced(ctx: DetectorContext, typical: Map<number, Map<number, Typical>>): Play[] {
  const plays: Play[] = [];
  const share = ctx.sellShare ?? DEFAULT_SELL_SHARE;
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
      if (!d || soldInWindow < UNDERPRICED.minDisappeared) continue;
      const judged = judgeSell(ctx, h, itemId, ls.filter(l => l.unitPrice! > line).length ? ls.filter(l => l.unitPrice! > line) : ls);
      if (judged.gates.length || judged.score < 40) {
        ctx.rejects?.push({ detector: 'underpriced', houseId: h.id, itemId, perItem: netPerUnit(h.faction, t.typicalFloor) - ls[0]!.unitPrice!, reason: judged.why, score: judged.score });
        continue;
      }
      const cheap = ls.filter(l => l.unitPrice! <= line);
      const available = cheap.reduce((s, l) => s + l.quantity, 0);
      const units = realisticUnits(available, d.unitsPerDay, share);
      if (units <= 0) continue;
      let left = units, cost = 0;
      for (const l of cheap) { if (left <= 0) break; const q = Math.min(left, l.quantity); cost += q * l.unitPrice!; left -= q; }
      const avgBuy = Math.round(cost / units);
      const relistAt = d.soldPrice != null ? Math.min(t.typicalFloor, d.soldPrice) : t.typicalFloor;
      const net = netPerUnit(h.faction, relistAt);
      const perItem = net - avgBuy;
      if (perItem <= 0) continue;
      const places = AUCTION_HOUSES[h.faction === 'blackwater' ? 'blackwater' : 'alliance'];
      const buy = { ...auctionLeg(h, avgBuy, places), note: `${Math.round((1 - ls[0]!.unitPrice! / t.typicalFloor) * 100)}% under its typical price` };
      const sell = { ...auctionLeg(h, net, places), note: `relist near the usual ${money(t.typicalFloor)}, before the cut` };
      const name = item?.name ?? `Item ${itemId}`;
      plays.push({
        key: `underpriced:${h.id}:${itemId}`, detector: 'underpriced', houseId: h.id, itemId, profit: perItem * units, confidence: judged.confidence,
        summary: playLine(name, perItem, buy, sell, d.unitsPerDay),
        detail: { buy, sell, perItem, salesPerDay: d.unitsPerDay, salesHours: d.hours, available, realisticUnits: units, typicalFloor: t.typicalFloor, readings: t.readings, oneOff: cheap.length === 1,
          listing: listingPlan(h.faction, item?.sellPrice, perItem, (d.unitsPerDay * share) / 24, units) },
        dataAt: h.publishedAt,
      });
    }
  }
  return plays;
}
