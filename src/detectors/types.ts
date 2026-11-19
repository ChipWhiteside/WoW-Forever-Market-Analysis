import type { Faction } from '../rules/fees.ts';
import type { Listing } from '../analysis/aggregate.ts';
import type { Place } from '../datasets/places.ts';
import type { ListingPlan } from '../rules/fees.ts';

export type DetectorId = 'vendor_dump' | 'vendor_supply' | 'underpriced' | 'craft' | 'sell_now' | 'cross_house' | 'world_drop';
export type Confidence = 'high' | 'medium' | 'low';

export interface Play {
  key: string;
  detector: DetectorId;
  houseId: number;
  itemId: number;
  /** realistic profit in copper: profit per item times realistic units. The sort key. */
  profit: number;
  confidence: Confidence;
  /** one plain sentence, what and where */
  summary: string;
  detail: PlayDetail;
  dataAt: number;
}

export interface HouseCtx { id: number; name: string; faction: Faction; cut: number; pinned: boolean; publishedAt: number }

export interface ItemCtx { id: number; name: string; sellPrice: number | null; binding: string | null; quality: string | null }

export interface VendorOffer { npcId: number; npcName: string; faction: string; zone: string | null; x: number | null; y: number | null; uiMap?: number | null; unitPrice: number; limited: boolean; minStanding: number }

/** Estimated sales, and the average price they happened at (null before any sale was seen). */
export interface Demand { unitsPerDay: number; hours: number; snapshots: number; soldPrice?: number | null;
  /** average sold price over the last 24 hours only, so a market that moved is read at today's level */
  recentSoldPrice?: number | null; recentSales?: number }

/** One side of a play: where you buy, or where you sell. */
export interface Leg {
  /** vendor = a named NPC, auction = an auction house, any_vendor = sell to any vendor, held = what you already own */
  kind: 'vendor' | 'auction' | 'any_vendor' | 'held';
  /** copper per item: what you pay, or what lands in your mailbox after the cut */
  price: number;
  /** NPC name or house name */
  who: string;
  places: Place[];
  houseId?: number;
  note?: string;
}

/** The standard detail every play carries, so every card and alert reads the same way. */
export interface PlayDetail {
  buy: Leg;
  sell: Leg;
  /** profit per item in copper, the big number */
  perItem: number;
  /** estimated units sold a day on the selling house, null until history exists */
  salesPerDay: number | null;
  /** hours of sales history behind salesPerDay */
  salesHours?: number;
  /** units at the buy price right now */
  available: number;
  /** units worth doing today: all of them for a vendor, else Chip's share of daily sales */
  realisticUnits: number;
  listing?: ListingPlan;
  oneOff?: boolean;
  [k: string]: unknown;
}

export interface DetectorContext {
  houses: HouseCtx[];
  /** current listings per house, both kinds merged */
  listings: Map<number, Listing[]>;
  items: Map<number, ItemCtx>;
  vendors: Map<number, VendorOffer[]>;
  /** estimated units sold per day near the floor, per house then item */
  demand: Map<number, Map<number, Demand>>;
  now: number;
  /** share of a market's daily sales Chip can realistically take, default 0.2 */
  sellShare?: number;
  /** when present, detectors record candidates they held back and why ("closest calls") */
  rejects?: Reject[];
}

export interface Reject { detector: DetectorId; houseId: number; itemId: number; perItem: number | null; reason: string; score?: number }

/** Group a house's listings by item, cheapest first, buyout only. */
export function byItem(listings: Listing[]): Map<number, Listing[]> {
  const m = new Map<number, Listing[]>();
  for (const l of listings) {
    if (l.unitPrice == null) continue;
    let a = m.get(l.itemId);
    if (!a) m.set(l.itemId, (a = []));
    a.push(l);
  }
  for (const a of m.values()) a.sort((x, y) => x.unitPrice! - y.unitPrice!);
  return m;
}

/** "Alliance" or "Blackwater", plus the house id when it is not one of Chip's pinned houses. */
export const houseLabel = (h: HouseCtx) => `${h.faction === 'alliance' ? 'Alliance' : h.faction === 'blackwater' ? 'Blackwater' : 'Horde'}${h.pinned ? '' : ` ${h.id}`}`;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const DEFAULT_SELL_SHARE = 0.2;

/** What the card shows about price: cheapest levels [price, units, listings], recent sales, the price used and why. */
export interface PricePicture { levels: Array<[number, number, number]>; thinTop: boolean; recentSoldPrice: number | null; recentSales: number; soldPrice: number | null; used: 'listed' | 'sold' | 'market'; note: string }

/** Units worth doing in a day: Chip's share of daily sales, at least 1, never more than what is available. */
export function realisticUnits(available: number, salesPerDay: number | null, share = DEFAULT_SELL_SHARE): number {
  if (salesPerDay == null) return Math.min(available, 1);
  if (salesPerDay <= 0) return 0; // measured: nothing sells, so nothing is worth doing
  return Math.max(1, Math.min(available, Math.round(salesPerDay * share)));
}

export function auctionLeg(h: HouseCtx, price: number, places: Place[]): Leg {
  return { kind: 'auction', price, who: `${houseLabel(h)} auction house`, places, houseId: h.id };
}

import { marketPrice, priceGates, confidenceScore, confidenceLabel, sellPrice as safeSellPrice, PRICE, type Evidence } from '../rules/price.ts';

/**
 * Judge a sell side: the price a play may claim, why it might be junk, and a 0 to 100 confidence.
 * Every detector that resells on the auction house goes through this, so one troll listing can never set a price.
 */
export function judgeSell(ctx: DetectorContext, house: HouseCtx, itemId: number, ladder: Listing[]): {
  price: number; market: number | null; evidence: Evidence; gates: string[]; score: number; confidence: Confidence; show: boolean; why: string; picture: PricePicture;
} {
  const floor = ladder[0]!.unitPrice!;
  const m = marketPrice(ladder);
  const d = ctx.demand.get(house.id)?.get(itemId);
  const item = ctx.items.get(itemId);
  const offers = ctx.vendors.get(itemId);
  const provenSales = d ? Math.round((d.unitsPerDay * d.hours) / 24) : 0;
  // Prefer the last 24 hours of sales when there are enough of them: prices move fast in a young economy.
  const recentOk = (d?.recentSales ?? 0) >= 3 && d?.recentSoldPrice != null;
  const soldRef = recentOk ? d!.recentSoldPrice! : provenSales > 0 ? d?.soldPrice ?? null : null;
  const price = safeSellPrice(floor, m?.price ?? null, soldRef);
  const evidence: Evidence = {
    hours: d?.hours ?? 0, listings: m?.listings ?? ladder.length, provenSales, soldPrice: d?.soldPrice ?? null, askPrice: price,
    quality: item?.quality ?? null, vendorSell: item?.sellPrice ?? null, vendorBuy: offers?.length ? Math.min(...offers.map(o => o.unitPrice)) : null,
  };
  const gates = priceGates(evidence);
  const score = confidenceScore(evidence, gates);
  const short: string[] = [];
  if (evidence.provenSales < 3) short.push(evidence.provenSales ? `only ${evidence.provenSales} sales seen so far` : 'no sales seen yet');
  if (evidence.listings < 3) short.push(`only ${evidence.listings} listing${evidence.listings === 1 ? '' : 's'} up`);
  if (evidence.hours < 6) short.push(`${evidence.hours} hours of sales history`);
  const why = gates.length ? gates[0]! : `confidence ${score}/100: ${short.join(', ') || 'thin evidence'}`;
  // The price picture shown on the card: the cheapest levels with their depth, recent sales, and which price was used and why.
  const levels: Array<[number, number, number]> = [];
  for (const l of ladder) {
    const last = levels[levels.length - 1];
    if (last && last[0] === l.unitPrice) { last[1] += l.quantity; last[2]++; } else if (levels.length < 5) levels.push([l.unitPrice!, l.quantity, 1]); else break;
  }
  const thinTop = levels.length > 1 && levels[0]![1] < 5 && levels[1]![0] > levels[0]![0] * 1.25;
  const used = price < floor ? (soldRef != null && price === soldRef ? 'sold' : 'market') : 'listed';
  const picture: PricePicture = {
    levels, thinTop, recentSoldPrice: d?.recentSoldPrice ?? null, recentSales: d?.recentSales ?? 0, soldPrice: d?.soldPrice ?? null, used,
    note: used === 'sold' ? `using what it actually sold for${recentOk ? ' in the last 24 hours' : ''}: the cheapest listing now is higher, but nothing has sold up there yet`
      : thinTop ? `only ${levels[0]![1]} at the cheapest price, then ${Math.round((levels[1]![0] / levels[0]![0] - 1) * 100)}% higher` : '',
  };
  return { price, market: m?.price ?? null, evidence, gates, score, confidence: confidenceLabel(score), show: !gates.length && score >= PRICE.showAt, why, picture };
}
