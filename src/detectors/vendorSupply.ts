import { money } from '../format/money.ts';
import { netPerUnit, listingPlan } from '../rules/fees.ts';
import { MIN_GAIN } from '../rules/thresholds.ts';
import { byItem, auctionLeg, realisticUnits, judgeSell, DEFAULT_SELL_SHARE, type DetectorContext, type Play, type Leg } from './types.ts';
import { AUCTION_HOUSES } from '../datasets/places.ts';
import { playLine } from './summary.ts';

/**
 * O2 Vendor to auction house. A vendor item listed well above what an Alliance usable vendor charges.
 * Profit per item = the floor after the cut minus the vendor price. Realistic units = Chip's share of daily sales.
 */
export function vendorSupply(ctx: DetectorContext): Play[] {
  const plays: Play[] = [];
  const share = ctx.sellShare ?? DEFAULT_SELL_SHARE;
  for (const h of ctx.houses) {
    for (const [itemId, ls] of byItem(ctx.listings.get(h.id) ?? [])) {
      const offers = ctx.vendors.get(itemId);
      if (!offers?.length) continue;
      const item = ctx.items.get(itemId);
      if (item?.binding === 'ON_ACQUIRE') continue;
      // Prefer vendors with a price recorded at Neutral or Friendly. An item only ever seen at Honored or above
      // may need reputation Chip lacks, so it stays at low confidence with a note.
      const open = offers.filter(o => o.minStanding <= 5);
      const best = (open.length ? open : offers).reduce((a, b) => (b.unitPrice < a.unitPrice ? b : a));
      const gated = !open.length;
      const judged = judgeSell(ctx, h, itemId, ls);
      if (!judged.show) {
        const est = netPerUnit(h.faction, judged.price) - best.unitPrice;
        if (est > 0) ctx.rejects?.push({ detector: 'vendor_supply', houseId: h.id, itemId, perItem: est, reason: judged.why, score: judged.score });
        continue;
      }
      const floor = judged.price;
      const net = netPerUnit(h.faction, floor);
      const perItem = net - best.unitPrice;
      if (perItem < MIN_GAIN.copper || perItem < best.unitPrice * MIN_GAIN.share) continue;
      const d = ctx.demand.get(h.id)?.get(itemId);
      const salesPerDay = d && d.hours >= 1 ? d.unitsPerDay : null;
      const units = best.limited ? 1 : realisticUnits(Infinity, salesPerDay, share);
      if (units <= 0) continue;
      const buy: Leg = { kind: 'vendor', price: best.unitPrice, who: best.npcName, places: [{ label: best.npcName, zone: best.zone, uiMap: best.uiMap ?? null, x: best.x, y: best.y }],
        note: [best.limited ? 'limited stock' : null, gated ? 'price only seen at Honored or better, may need reputation' : null].filter(Boolean).join(', ') || undefined };
      const sell = { ...auctionLeg(h, net, AUCTION_HOUSES[h.faction === 'blackwater' ? 'blackwater' : 'alliance']), note: judged.evidence.soldPrice != null ? `sells around ${money(floor)} before the cut` : `listed at ${money(floor)} before the cut, no sales seen yet` };
      const name = item?.name ?? `Item ${itemId}`;
      plays.push({
        key: `vendor_supply:${h.id}:${itemId}`, detector: 'vendor_supply', houseId: h.id, itemId, profit: perItem * units,
        confidence: gated || best.limited ? 'low' : judged.confidence,
        summary: playLine(name, perItem, buy, sell, salesPerDay),
        detail: { buy, sell, perItem, salesPerDay, salesHours: d?.hours, price: judged.picture, strength: judged.parts, why: judged.driver, available: Infinity, realisticUnits: units, floor, vendorPrice: best.unitPrice, score: judged.score, soldPrice: judged.evidence.soldPrice, limited: best.limited, reputationGated: gated,
          otherVendors: offers.filter(o => o !== best).slice(0, 5),
          listing: listingPlan(h.faction, item?.sellPrice, perItem, salesPerDay == null ? null : (salesPerDay * share) / 24, units) },
        dataAt: h.publishedAt,
      });
    }
  }
  return plays;
}
