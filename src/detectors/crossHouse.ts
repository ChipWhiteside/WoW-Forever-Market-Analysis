import { money } from '../format/money.ts';
import { netPerUnit, listingPlan } from '../rules/fees.ts';
import { MIN_GAIN } from '../rules/thresholds.ts';
import { byItem, auctionLeg, realisticUnits, judgeSell, DEFAULT_SELL_SHARE, type DetectorContext, type Play, type HouseCtx } from './types.ts';
import { AUCTION_HOUSES } from '../datasets/places.ts';
import { playLine } from './summary.ts';

/**
 * O7 Between houses. Buy on one of Chip's houses, carry it, list on the other. Only between his pinned houses.
 * Profit per item = the sell floor after its cut minus the average buy price of the units worth taking.
 */
export function crossHouse(ctx: DetectorContext): Play[] {
  const a = ctx.houses.find(h => h.pinned && h.faction === 'alliance');
  const b = ctx.houses.find(h => h.pinned && h.faction === 'blackwater');
  if (!a || !b) return [];
  return [...pair(ctx, a, b), ...pair(ctx, b, a)];
}

const placesOf = (h: HouseCtx) => AUCTION_HOUSES[h.faction === 'blackwater' ? 'blackwater' : 'alliance'];

function pair(ctx: DetectorContext, buyH: HouseCtx, sellH: HouseCtx): Play[] {
  const plays: Play[] = [];
  const share = ctx.sellShare ?? DEFAULT_SELL_SHARE;
  const buyBy = byItem(ctx.listings.get(buyH.id) ?? []);
  for (const [itemId, sells] of byItem(ctx.listings.get(sellH.id) ?? [])) {
    const buys = buyBy.get(itemId);
    if (!buys?.length) continue;
    const item = ctx.items.get(itemId);
    if (item?.binding === 'ON_ACQUIRE') continue;
    const judged = judgeSell(ctx, sellH, itemId, sells);
    if (!judged.show) {
      const est = netPerUnit(sellH.faction, judged.price) - buys[0]!.unitPrice!;
      if (est > 0) ctx.rejects?.push({ detector: 'cross_house', houseId: buyH.id, itemId, perItem: est, reason: judged.why, score: judged.score });
      continue;
    }
    const sellFloor = judged.price;
    const net = netPerUnit(sellH.faction, sellFloor);
    const d = ctx.demand.get(sellH.id)?.get(itemId);
    const salesPerDay = d && d.hours >= 1 ? d.unitsPerDay : null;
    let available = 0, spent = 0;
    for (const l of buys) {
      const gain = net - l.unitPrice!;
      if (gain < MIN_GAIN.copper || gain < l.unitPrice! * MIN_GAIN.share) break;
      available += l.quantity; spent += l.unitPrice! * l.quantity;
    }
    if (available === 0) continue;
    const units = realisticUnits(available, salesPerDay, share);
    if (units <= 0) continue;
    // Profit per item over the units worth taking today: the cheapest ones first.
    let left = units, cost = 0;
    for (const l of buys) { if (left <= 0) break; const q = Math.min(left, l.quantity); cost += q * l.unitPrice!; left -= q; }
    const avgBuy = Math.round(cost / units);
    const perItem = net - avgBuy;
    const buy = auctionLeg(buyH, avgBuy, placesOf(buyH));
    const sell = { ...auctionLeg(sellH, net, placesOf(sellH)), note: `listed at ${money(sellFloor)} before the ${Math.round(sellH.cut * 100)}% cut` };
    const name = item?.name ?? `Item ${itemId}`;
    plays.push({
      key: `cross_house:${buyH.id}>${sellH.id}:${itemId}`, detector: 'cross_house', houseId: buyH.id, itemId, profit: perItem * units,
      confidence: judged.confidence,
      summary: playLine(name, perItem, buy, sell, salesPerDay),
      detail: { buy, sell, perItem, salesPerDay, salesHours: d?.hours, price: judged.picture, strength: judged.parts, why: judged.driver, available, realisticUnits: units, buyHouse: buyH.id, sellHouse: sellH.id, sellFloor, score: judged.score,
        listing: listingPlan(sellH.faction, item?.sellPrice, perItem, salesPerDay == null ? null : (salesPerDay * share) / 24, units) },
      dataAt: Math.min(buyH.publishedAt, sellH.publishedAt),
    });
  }
  return plays;
}
