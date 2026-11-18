import { money } from '../format/money.ts';
import { netPerUnit } from '../rules/fees.ts';
import { MIN_GAIN } from '../rules/thresholds.ts';
import { byItem, houseLabel, plural, type DetectorContext, type Play, type HouseCtx } from './types.ts';

/**
 * O7 Cross house flip. Buy on one of Chip's houses, carry it, list on the other.
 * Only runs between his pinned Alliance and pinned Blackwater house.
 * Profit available = for each buy side listing that clears the sell side's break even, net sale minus price,
 * capped at the sell side's daily demand once known.
 */
export function crossHouse(ctx: DetectorContext): Play[] {
  const a = ctx.houses.find(h => h.pinned && h.faction === 'alliance');
  const b = ctx.houses.find(h => h.pinned && h.faction === 'blackwater');
  if (!a || !b) return [];
  return [...pair(ctx, a, b), ...pair(ctx, b, a)];
}

function pair(ctx: DetectorContext, buy: HouseCtx, sell: HouseCtx): Play[] {
  const plays: Play[] = [];
  const buyBy = byItem(ctx.listings.get(buy.id) ?? []);
  const sellBy = byItem(ctx.listings.get(sell.id) ?? []);
  for (const [itemId, sells] of sellBy) {
    const buys = buyBy.get(itemId);
    if (!buys?.length) continue;
    const item = ctx.items.get(itemId);
    if (item?.binding === 'ON_ACQUIRE') continue;
    const sellFloor = sells[0]!.unitPrice!;
    const net = netPerUnit(sell.faction, sellFloor, item?.sellPrice);
    const d = ctx.demand.get(sell.id)?.get(itemId);
    const known = !!d && d.hours >= 3;
    let cap = known ? Math.max(1, Math.round(d!.unitsPerDay)) : Infinity;
    let profit = 0, units = 0;
    for (const l of buys) {
      const gain = net - l.unitPrice!;
      if (gain < MIN_GAIN.copper || gain < l.unitPrice! * MIN_GAIN.share || cap <= 0) break;
      const q = Math.min(l.quantity, cap);
      profit += gain * q; units += q; cap -= q;
    }
    if (units === 0) continue;
    const name = item?.name ?? `Item ${itemId}`;
    const gainFirst = net - buys[0]!.unitPrice!;
    plays.push({
      key: `cross_house:${buy.id}>${sell.id}:${itemId}`,
      detector: 'cross_house', houseId: buy.id, itemId, profit,
      confidence: known ? 'medium' : 'low',
      summary: `${name} is ${money(buys[0]!.unitPrice)} on ${houseLabel(buy)} and ${money(sellFloor)} on ${houseLabel(sell)}. About ${money(gainFirst)} each after the ${Math.round(sell.cut * 100)}% cut, ${plural(units, 'unit')} clear it.`,
      detail: { buyHouse: buy.id, sellHouse: sell.id, buyFloor: buys[0]!.unitPrice, sellFloor, netPerUnit: net, units, demandPerDay: known ? d!.unitsPerDay : null },
      dataAt: Math.min(buy.publishedAt, sell.publishedAt),
    });
  }
  return plays;
}
