/**
 * PROTECTED. Auction house fees. Changes here change every profit number in the tool,
 * so the overnight loop may propose but never auto merge edits to this folder.
 *
 * Cut: 5 percent Alliance, 15 percent Blackwater, verified from Chip's own sales (V18).
 * Deposit: from Chip's own listing of Coarse Stone (vendor price 15c) on November 19:
 *   2 hours 6c, 8 hours 24c, 24 hours 72c. That is 20 percent of the vendor price per hour, per unit.
 * Blackwater charging five times as much is still a guide claim, not verified (T7).
 * The deposit is assumed refunded when the item sells and kept when it expires (V19 confirms the second half).
 */
export type Faction = 'alliance' | 'horde' | 'blackwater';
export type Duration = 2 | 8 | 24;
export const DURATIONS: Duration[] = [2, 8, 24];

export const CUT: Record<Faction, number> = { alliance: 0.05, horde: 0.05, blackwater: 0.15 };
export const cutFor = (f: Faction) => CUT[f];

export const DEPOSIT = {
  /** share of the vendor sell price, per unit, per hour listed. Verified on Alliance from Coarse Stone */
  ratePerHour: 0.2,
  blackwaterMultiplier: 5,
  minimumCopper: 1,
  verifiedAlliance: true,
  verifiedBlackwater: false,
} as const;

/** Deposit in copper to list `qty` units for `hours`. Refunded on sale, lost on expiry. */
export function deposit(faction: Faction, sellPrice: number | null | undefined, qty = 1, hours: Duration = 2): number {
  const base = Math.floor((sellPrice ?? 0) * qty * DEPOSIT.ratePerHour * hours);
  const mult = faction === 'blackwater' ? DEPOSIT.blackwaterMultiplier : 1;
  return Math.max(DEPOSIT.minimumCopper, base) * mult;
}

/**
 * What lands in Chip's mailbox per unit when an item sells at `price` on this house, after the cut.
 * The deposit comes back on a sale, so it is not a cost of a sale; it is a risk on what does not sell,
 * which the listing plan prices for each duration.
 */
export function netPerUnit(faction: Faction, price: number, _sellPrice?: number | null): number {
  return Math.floor(price * (1 - CUT[faction]));
}

/** Lowest selling price on `faction` that breaks even against a cost per unit, after the cut. */
export function breakEvenPrice(faction: Faction, cost: number, _sellPrice?: number | null): number {
  return Math.ceil(cost / (1 - CUT[faction]));
}

export interface ListingOption { hours: Duration; depositEach: number; expectedSold: number | null; expectedProfit: number | null; sellsOut: boolean }
export interface ListingPlan { quantity: number; options: ListingOption[]; best: Duration; why: string }

/**
 * Which listing length to use for a stack of `quantity` at a net `profitEach`, given how fast Chip's share of the
 * market sells (`unitsPerHour`). Expected profit = sold x profit each, minus the deposit lost on what expires.
 * When a shorter listing already sells the whole stack, the shorter one wins: less deposit at risk and less time
 * for someone to undercut. Otherwise the most expected profit wins.
 */
export function listingPlan(faction: Faction, sellPrice: number | null | undefined, profitEach: number, unitsPerHour: number | null, quantity: number): ListingPlan {
  const q = Math.max(1, Math.round(quantity));
  const options = DURATIONS.map(hours => {
    const depositEach = deposit(faction, sellPrice, 1, hours);
    // With no sales rate, say so: never invent how many would sell.
    if (unitsPerHour == null) return { hours, depositEach, expectedSold: null, expectedProfit: null, sellsOut: false };
    const sold = Math.min(q, unitsPerHour * hours);
    const expectedProfit = Math.round(sold * profitEach - (q - sold) * depositEach);
    return { hours, depositEach, expectedSold: Math.round(sold * 10) / 10, expectedProfit, sellsOut: sold >= q };
  });
  if (unitsPerHour == null) return { quantity: q, options, best: 24, why: 'Sales rate not known yet, the longest listing gives it the most time.' };
  const firstSellOut = options.find(o => o.sellsOut);
  if (firstSellOut) return { quantity: q, options, best: firstSellOut.hours, why: `${q} sell within ${firstSellOut.hours} hours at your share of the market, so the shortest listing that sells out wins.` };
  const top = [...options].sort((a, b) => (b.expectedProfit ?? 0) - (a.expectedProfit ?? 0))[0]!;
  return { quantity: q, options, best: top.hours, why: `No listing length sells all ${q}; ${top.hours} hours earns the most after expired deposits.` };
}
