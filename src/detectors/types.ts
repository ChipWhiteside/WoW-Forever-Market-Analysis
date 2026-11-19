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

export interface Demand { unitsPerDay: number; hours: number; snapshots: number }

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
}

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

/** Units worth doing in a day: Chip's share of daily sales, at least 1, never more than what is available. */
export function realisticUnits(available: number, salesPerDay: number | null, share = DEFAULT_SELL_SHARE): number {
  if (salesPerDay == null) return Math.min(available, 1);
  if (salesPerDay <= 0) return 0; // measured: nothing sells, so nothing is worth doing
  return Math.max(1, Math.min(available, Math.round(salesPerDay * share)));
}

export function auctionLeg(h: HouseCtx, price: number, places: Place[]): Leg {
  return { kind: 'auction', price, who: `${houseLabel(h)} auction house`, places, houseId: h.id };
}
