import { money } from '../format/money.ts';
import { netPerUnit } from '../rules/fees.ts';
import { MIN_GAIN } from '../rules/thresholds.ts';
import { byItem, houseLabel, plural, type DetectorContext, type Play } from './types.ts';

/**
 * O2 Vendor supply. A vendor item listed well above what an Alliance usable vendor charges.
 * Profit available = net gain per unit at the current floor times estimated daily demand.
 * Before demand is known, profit counts one purchase stack and confidence drops to low.
 */
export function vendorSupply(ctx: DetectorContext): Play[] {
  const plays: Play[] = [];
  for (const h of ctx.houses) {
    for (const [itemId, ls] of byItem(ctx.listings.get(h.id) ?? [])) {
      const offers = ctx.vendors.get(itemId);
      if (!offers?.length) continue;
      const item = ctx.items.get(itemId);
      if (item?.binding === 'ON_ACQUIRE') continue;
      // Prefer vendors with a price recorded at Neutral or Friendly. An item only ever seen at Honored or above
      // may need reputation Chip lacks (review finding 4), so it stays, at low confidence and with a note.
      const open = offers.filter(o => o.minStanding <= 5);
      const pickFrom = open.length ? open : offers;
      const best = pickFrom.reduce((a, b) => (b.unitPrice < a.unitPrice ? b : a));
      const gated = !open.length;
      const floor = ls[0]!.unitPrice!;
      const gain = netPerUnit(h.faction, floor, item?.sellPrice) - best.unitPrice;
      if (gain < MIN_GAIN.copper || gain < best.unitPrice * MIN_GAIN.share) continue;
      const d = ctx.demand.get(h.id)?.get(itemId);
      const known = !!d && d.hours >= 3 && d.unitsPerDay > 0;
      // Limited stock vendors restock slowly, so only one purchase counts (review finding 3).
      const units = best.limited ? 1 : known ? Math.round(d!.unitsPerDay) : 1;
      const profit = gain * units;
      const name = item?.name ?? `Item ${itemId}`;
      const where = [best.npcName, best.zone, best.x != null ? `${best.x}, ${best.y}` : null].filter(Boolean).join(', ');
      plays.push({
        key: `vendor_supply:${h.id}:${itemId}`,
        detector: 'vendor_supply', houseId: h.id, itemId, profit,
        confidence: known && !gated && !best.limited ? 'medium' : 'low',
        summary: `${name} sells for ${money(floor)} on ${houseLabel(h)} and ${best.npcName} sells it for ${money(best.unitPrice)}. About ${money(gain)} each after the cut` +
          (known ? `, roughly ${Math.round(d!.unitsPerDay)} sell a day.` : `. Demand not known yet.`) +
          (best.limited ? ' Limited stock.' : '') + (gated ? ' Price only seen at Honored or better, may need reputation.' : ''),
        detail: { floor, vendorPrice: best.unitPrice, limited: best.limited, reputationGated: gated, gainPerUnit: gain, demandPerDay: known ? d!.unitsPerDay : null, demandHours: d?.hours ?? 0,
          vendor: best, otherVendors: offers.filter(o => o !== best).slice(0, 5), where, unitsAtFloor: ls.filter(l => l.unitPrice === floor).reduce((s, l) => s + l.quantity, 0) },
        dataAt: h.publishedAt,
      });
    }
  }
  return plays;
}
