import { money } from '../format/money.ts';
import { byItem, type DetectorContext, type Play } from './types.ts';

/**
 * O1 Vendor dump. A listing priced below what any vendor pays for the item.
 * Any vendor buys at sell_price (V6), so no trip and no cut. Confidence high.
 */
export function vendorDump(ctx: DetectorContext): Play[] {
  const plays: Play[] = [];
  for (const h of ctx.houses) {
    for (const [itemId, ls] of byItem(ctx.listings.get(h.id) ?? [])) {
      const item = ctx.items.get(itemId);
      const sell = item?.sellPrice;
      if (!sell || sell <= 0) continue;
      let profit = 0, units = 0, listings = 0;
      for (const l of ls) {
        if (l.unitPrice! >= sell) break;
        profit += (sell - l.unitPrice!) * l.quantity;
        units += l.quantity;
        listings++;
      }
      if (units === 0) continue;
      const name = item?.name ?? `Item ${itemId}`;
      plays.push({
        key: `vendor_dump:${h.id}:${itemId}`,
        detector: 'vendor_dump', houseId: h.id, itemId, profit,
        confidence: 'high',
        summary: `${units} ${name} listed under the ${money(sell)} vendor price on ${h.name}. Buy them and sell to any vendor for about ${money(profit)}.`,
        detail: { vendorSell: sell, units, listings, cheapest: ls[0]!.unitPrice, oneOff: listings === 1, ladder: ladderOf(ls) },
        dataAt: h.publishedAt,
      });
    }
  }
  return plays;
}

export function ladderOf(ls: Array<{ unitPrice: number | null; quantity: number }>, points = 8): Array<[number, number]> {
  const m = new Map<number, number>();
  for (const l of ls) if (l.unitPrice != null) m.set(l.unitPrice, (m.get(l.unitPrice) ?? 0) + l.quantity);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).slice(0, points);
}
