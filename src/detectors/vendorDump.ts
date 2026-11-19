import { money } from '../format/money.ts';
import { byItem, auctionLeg, type DetectorContext, type Play } from './types.ts';
import { AUCTION_HOUSES } from '../datasets/places.ts';
import { playLine } from './summary.ts';

/**
 * O1 Auction house to vendor. A listing priced below what any vendor pays for the item.
 * Any vendor buys at sell_price (V6) with no cut and no limit, so every unit under the line counts.
 */
export function vendorDump(ctx: DetectorContext): Play[] {
  const plays: Play[] = [];
  for (const h of ctx.houses) {
    for (const [itemId, ls] of byItem(ctx.listings.get(h.id) ?? [])) {
      const item = ctx.items.get(itemId);
      const sell = item?.sellPrice;
      if (!sell || sell <= 0) continue;
      let total = 0, units = 0, listings = 0, spent = 0;
      for (const l of ls) {
        if (l.unitPrice! >= sell) break;
        total += (sell - l.unitPrice!) * l.quantity;
        spent += l.unitPrice! * l.quantity;
        units += l.quantity;
        listings++;
      }
      if (units === 0) continue;
      const name = item?.name ?? `Item ${itemId}`;
      const avgBuy = Math.round(spent / units);
      const buy = { ...auctionLeg(h, avgBuy, AUCTION_HOUSES[h.faction === 'blackwater' ? 'blackwater' : 'alliance']), note: listings > 1 ? `${units} units from ${money(ls[0]!.unitPrice)} up` : undefined };
      const sellLeg = { kind: 'any_vendor' as const, price: sell, who: 'Any vendor', places: [] };
      const perItem = Math.round(total / units);
      plays.push({
        key: `vendor_dump:${h.id}:${itemId}`, detector: 'vendor_dump', houseId: h.id, itemId, profit: total, confidence: listings === 1 ? 'medium' : 'high',
        summary: playLine(name, perItem, buy, sellLeg, null),
        detail: { buy, sell: sellLeg, perItem, salesPerDay: null, available: units, realisticUnits: units, oneOff: listings === 1 },
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
