import type { Faction } from '../rules/fees.ts';
import type { Listing } from '../analysis/aggregate.ts';

export type DetectorId = 'vendor_dump' | 'vendor_supply' | 'underpriced' | 'craft' | 'sell_now' | 'cross_house' | 'world_drop';
export type Confidence = 'high' | 'medium' | 'low';

export interface Play {
  key: string;
  detector: DetectorId;
  houseId: number;
  itemId: number;
  /** profit available in copper, as each detector defines it */
  profit: number;
  confidence: Confidence;
  /** one plain sentence, what and where */
  summary: string;
  detail: Record<string, unknown>;
  dataAt: number;
}

export interface HouseCtx { id: number; name: string; faction: Faction; cut: number; pinned: boolean; publishedAt: number }

export interface ItemCtx { id: number; name: string; sellPrice: number | null; binding: string | null; quality: string | null }

export interface VendorOffer { npcId: number; npcName: string; faction: string; zone: string | null; x: number | null; y: number | null; unitPrice: number; limited: boolean; minStanding: number }

export interface Demand { unitsPerDay: number; hours: number; snapshots: number }

export interface DetectorContext {
  houses: HouseCtx[];
  /** current listings per house, both kinds merged */
  listings: Map<number, Listing[]>;
  items: Map<number, ItemCtx>;
  vendors: Map<number, VendorOffer[]>;
  /** estimated units sold per day near the floor, per house then item */
  demand: Map<number, Map<number, Demand>>;
  now: number;
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
