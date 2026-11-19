/**
 * PROTECTED. What an item really sells for, and how much to trust it. Based on TradeSkillMaster's documented
 * market value method (cheapest 15 to 30 percent of units, cut at the first 20 percent price jump, trim outliers
 * beyond 1.5 standard deviations, weighted mean) plus gates for the junk a young economy produces.
 * Every threshold here is a starting value from TSM's public numbers or a first guess, recorded in
 * docs/verification.md, and tuned from the calibration report.
 */
import type { Listing } from '../analysis/aggregate.ts';

export const PRICE = {
  cheapestShare: 0.15, maxShare: 0.3, jump: 1.2, sdTrim: 1.5,
  thinListings: 3,
  /** a common or poor item listed above this many times what a vendor pays is an ask outlier */
  qualityOutlier: 20,
  /** a vendor item listed above this many times what the vendor charges is an ask outlier */
  vendorOutlier: 20,
  /** proven sales needed at an outlier level before it counts */
  outlierSalesNeeded: 3,
  showAt: 40, opportunityAt: 60,
};

/** Market price from one snapshot's listings of one item, by units. Null when there are no buyout listings. */
export function marketPrice(listings: Array<Pick<Listing, 'unitPrice' | 'quantity'>>): { price: number; listings: number; units: number; thin: boolean } | null {
  const ls = listings.filter(l => l.unitPrice != null).sort((a, b) => a.unitPrice! - b.unitPrice!);
  if (!ls.length) return null;
  const units = ls.reduce((s, l) => s + l.quantity, 0);
  // Walk the cheapest units: always the first 15 percent (at least one listing), then up to 30 percent while
  // each next price is under 1.2 times the previous.
  const take: Array<[number, number]> = [];
  let got = 0, prev: number | null = null;
  for (const l of ls) {
    const p = l.unitPrice!;
    if (take.length && got >= units * PRICE.cheapestShare) {
      if (got >= units * PRICE.maxShare || (prev != null && p >= prev * PRICE.jump)) break;
    }
    take.push([p, l.quantity]); got += l.quantity; prev = p;
  }
  const w = take.reduce((s, [, q]) => s + q, 0);
  const mean = take.reduce((s, [p, q]) => s + p * q, 0) / w;
  const sd = Math.sqrt(take.reduce((s, [p, q]) => s + q * (p - mean) ** 2, 0) / w);
  const kept = sd > 0 ? take.filter(([p]) => Math.abs(p - mean) <= PRICE.sdTrim * sd) : take;
  const kw = kept.reduce((s, [, q]) => s + q, 0);
  const price = Math.round(kept.reduce((s, [p, q]) => s + p * q, 0) / kw);
  return { price, listings: ls.length, units, thin: ls.length < PRICE.thinListings };
}

export interface Evidence {
  /** hours of history behind the demand numbers */
  hours: number;
  listings: number;
  /** sales seen near the floor over the window */
  provenSales: number;
  /** average price those sales happened at */
  soldPrice: number | null;
  /** the price the play claims to sell at, before the cut */
  askPrice: number;
  quality: string | null;
  /** what any vendor pays for the item */
  vendorSell: number | null;
  /** what the cheapest Alliance usable vendor charges for it, if any sells it */
  vendorBuy: number | null;
  /** how much the hourly floor wandered over 3 days: standard deviation over mean (null with too few readings) */
  floorCv?: number | null;
  /** listings within 10 percent of the cheapest price: how many sellers hold the price up */
  listingsNear?: number;
  /** why people buy it */
  driver?: 'quest' | 'recipe' | null;
}

/** One line per factor, so the card can say why a play is strong or weak. */
export interface StrengthPart { label: string; points: number; max: number }

/** Reasons a price should not be believed yet. Empty means it passes. */
export function priceGates(e: Evidence): string[] {
  const out: string[] = [];
  const outlierOk = e.provenSales >= PRICE.outlierSalesNeeded && e.soldPrice != null && e.soldPrice >= e.askPrice * 0.7;
  if ((e.quality === 'COMMON' || e.quality === 'POOR') && e.vendorSell && e.askPrice > e.vendorSell * PRICE.qualityOutlier && !outlierOk)
    out.push(`a ${e.quality.toLowerCase()} item listed at over ${PRICE.qualityOutlier} times its vendor price, with no sales seen there`);
  if (e.vendorBuy && e.askPrice > e.vendorBuy * PRICE.vendorOutlier && !outlierOk)
    out.push(`anyone can buy it from a vendor for far less, and nothing has sold near this price`);
  return out;
}

/**
 * Strength 0 to 100: how much to trust that this price is real and will hold. TSM style evidence (history, sales,
 * price agreement) plus what Chip asked for: how many listings back the price, how steady it has been, and why
 * people buy the item (a quest turn in is the strongest demand, a crafting reagent next).
 */
export function strength(e: Evidence, gates: string[]): { score: number; parts: StrengthPart[] } {
  const parts: StrengthPart[] = [
    { label: 'days of history', points: Math.round(Math.min(e.hours / 24, 7) * 3), max: 21 },
    { label: 'listings holding the price', points: (e.listingsNear ?? e.listings) >= 5 ? 12 : (e.listingsNear ?? e.listings) >= 3 ? 6 : 0, max: 12 },
    { label: 'sales seen', points: e.provenSales >= 10 ? 20 : e.provenSales >= 3 ? 12 : e.provenSales >= 1 ? 4 : 0, max: 20 },
    { label: 'sold near this price', points: e.soldPrice != null && Math.abs(e.soldPrice - e.askPrice) <= e.askPrice * 0.3 ? 15 : 0, max: 15 },
    { label: 'steady price', points: e.floorCv == null ? 0 : e.floorCv < 0.1 ? 12 : e.floorCv < 0.25 ? 6 : 0, max: 12 },
    { label: e.driver === 'quest' ? 'quest item' : e.driver === 'recipe' ? 'crafting reagent' : 'demand reason', points: e.driver === 'quest' ? 12 : e.driver === 'recipe' ? 6 : 0, max: 12 },
    { label: 'passes junk checks', points: gates.length ? 0 : 8, max: 8 },
  ];
  return { score: Math.min(100, parts.reduce((a, p) => a + p.points, 0)), parts };
}

/** Kept for callers that only need the number. */
export function confidenceScore(e: Evidence, gates: string[]): number { return strength(e, gates).score; }

export const confidenceLabel = (score: number): 'high' | 'medium' | 'low' => score >= 75 ? 'high' : score >= PRICE.opportunityAt ? 'medium' : 'low';

/**
 * The price a play may claim to sell at: never above what the market's cheapest units say, and never above
 * where sales have actually happened when that is known.
 */
export function sellPrice(floor: number, market: number | null, soldPrice: number | null): number {
  let p = Math.min(floor, market ?? floor);
  if (soldPrice != null) p = Math.min(p, soldPrice);
  return p;
}
