/**
 * The flip engine's shared shapes (docs/flip-plan.md). Every family produces a Flip; the page, the run report,
 * the backtest and the tests all read this one shape. Money is copper. Prices per single item unless named.
 */
import type { Faction } from '../rules/fees.ts';
import type { Place } from '../datasets/places.ts';

/** Green card or blue card. */
export type FlipKind = 'craft' | 'flip';

export type Family =
  | 'craft_auction' | 'craft_vendor' | 'conversion' | 'disenchant'
  | 'vendor_auction' | 'auction_vendor' | 'cross_house' | 'cheap_listing';

export const FAMILY_KIND: Record<Family, FlipKind> = {
  craft_auction: 'craft', craft_vendor: 'craft', conversion: 'craft', disenchant: 'craft',
  vendor_auction: 'flip', auction_vendor: 'flip', cross_house: 'flip', cheap_listing: 'flip',
};

/** One of Chip's two houses. No other house ever produces a flip. */
export interface HouseRef { id: number; name: string; faction: Faction; cut: number; publishedAt: number }

export type CostSource = 'auction' | 'vendor' | 'craft';

/** A run of units available at one unit cost. A curve is these, cheapest first. */
export interface CurveStep {
  unitCost: number;
  /** units at this cost; Infinity for an unlimited vendor */
  units: number;
  source: CostSource;
  houseId?: number;
  vendor?: { npcId: number; npcName: string; zone: string | null; places: Place[]; bundle: number; limited: boolean };
  recipeId?: number;
}

/** What getting N of an item costs, cheapest unit first. */
export interface CostCurve { itemId: number; steps: CurveStep[] }

/** What selling one item nets, on one house or to a vendor. */
export interface SellQuote {
  /** null = sell to any vendor */
  houseId: number | null;
  /** price the flip claims, before the cut: never above where real sales happened */
  claimPrice: number;
  /** what lands in the mailbox per unit after the cut */
  netEach: number;
  /** the price assumed after one typical undercut, before the cut */
  undercutPrice: number;
  /** cheapest listed price now */
  listed: number | null;
  basis: 'sold' | 'market' | 'listed' | 'vendor' | 'sweep';
  /** units listed at or under the price Chip would post at */
  ahead: number;
  /** low (cautious) and middle estimates of units sold a day; null when unknown */
  salesPerDayLow: number | null;
  salesPerDayMid: number | null;
  hoursWatched: number;
  /** new units other sellers post at or under the floor, per hour */
  newPerHour: number;
  /** highest price buyers paid in the last hour, when a sweep was seen */
  sweepHigh: number | null;
  /** lowest hourly floor in the last 3 days, for the bad case */
  low3d: number | null;
  /** floor standard deviation over mean, 3 days */
  cv: number | null;
  strength: number;
  strengthParts: Array<{ label: string; points: number; max: number }>;
  /** reasons the price is not believed; empty when it passes */
  gates: string[];
  rising: boolean;
  /** sales seen near the floor over the watched window (judgeSell's evidence) */
  provenSales?: number;
  /** one typical undercut in copper; Chip posts at claimPrice minus this */
  undercut?: number;
  /** when rising: the higher price buyers paid in the last hour, shown as "up to", never ranked on */
  upTo?: number | null;
  /** true when salesPerDayLow or newPerHour is the engine's own cautious estimate, not sale counting's */
  lowDerived?: boolean;
  newDerived?: boolean;
  /** new listings other sellers are expected to post under Chip over the horizon (newPerHour times the hours) */
  newOvernight?: number;
  /** one plain sentence about the price, for the card */
  note?: string | null;
  /** sale events (listings bought) seen over the hours watched, and the mean units each took (round 1 finding H1) */
  saleEvents?: number | null;
  unitsPerEvent?: number | null;
  /** hours of floors behind low3d; under 72 the bad case assumes the 25 percent drop unless the low seen is lower */
  lowCoverHours?: number | null;
  /** the floor's change since the previous publish as a share (-0.12 fell 12 percent), and new units posted that hour */
  floorChange1h?: number | null;
  newLastHour?: number | null;
  /** units counted in `ahead` that this flip buys itself (cheap listing): whatever it leaves stays ahead of Chip */
  ownAhead?: number;
}

export interface Risk {
  /** total gold spent to do it, deposits on every unit posted included */
  atStake: number;
  /** loss if the price falls to its 3 day low (a 25 percent drop until 3 days are watched) and only half the units
   * expected to sell actually sell; unsold units are salvaged at the vendor price and lose their deposit */
  badCaseLoss: number;
  /** expected profit at the claimed price when only half the units expected to sell actually sell */
  halfSalesProfit?: number;
  /** deposits on every unit posted, part of atStake */
  deposits?: number;
  daysToSell: number | null;
  level: 'low' | 'medium' | 'high';
  drivers: string[];
}

export interface QuantityOption {
  label: 'small' | 'best' | 'most';
  /** plain words about this row, for example that it goes past one crafting session */
  note?: string;
  /** minutes of casting in this row, part of minutes */
  castMinutes?: number;
  units: number;
  cost: number;
  expectedSold: number;
  /** units expected to sell tomorrow after being relisted (carryover, round 2 H1); 0 when nothing carries over */
  soldTomorrow?: number;
  expectedProfit: number;
  minutes: number;
  goldPerHour: number | null;
  risk: Risk;
}

export interface FlipLeg {
  kind: 'auction' | 'vendor' | 'any_vendor' | 'craft';
  itemId: number; name: string;
  /** units needed for the best quantity */
  units: number;
  /** average unit price paid (buy legs) or net per unit (sell leg) */
  unitPrice: number;
  who: string;
  houseId?: number;
  places: Place[];
  note?: string;
}

export interface Flip {
  key: string;
  kind: FlipKind;
  family: Family;
  itemId: number;
  name: string;
  recipeId?: number;
  recipeName?: string;
  profession?: string;
  /** the house it sells on; null when it sells to a vendor */
  sellHouseId: number | null;
  buy: FlipLeg[];
  sell: FlipLeg;
  /** profit per item at the best quantity, the big number */
  perItem: number;
  best: QuantityOption;
  options: QuantityOption[];
  sellQuote: SellQuote;
  repeatable: boolean;
  /** new this hour, or a price that just rose on real sweep evidence */
  opening: 'new' | 'rising' | null;
  /** hours open in the last 72, for trends */
  openHours72: number;
  /** one time setup for crafts: where and what it costs to learn */
  setup?: {
    skill: string; rank: number | null; cost: number | null; where: string | null; places: Place[];
    /** the item that teaches it, when one does, and its cheapest price on Chip's houses when listed */
    teachItem?: { id: number; name: string } | null;
    auctionPrice?: number | null;
    auctionHouseId?: number | null;
    /** true when nothing on record says how to learn it (no trainer, no teaching item, learn source unknown) */
    unknown?: boolean;
    /** every profession the craft tree uses at the best amount, with the highest skill it needs and the recipes */
    needs?: Array<{ profession: string; rank: number | null; recipes: string[] }>;
    /** the same in words: "needs Tailoring 310 and Alchemy 275 (Transmute: Arcanite)" */
    needsText?: string;
    /** tools the recipe needs, when known; a plain note when tools are not on record */
    tools?: string[];
    toolsNote?: string;
  } | null;
  /** keys of higher ranked flips that use the same reagent listings, buyers or gold */
  shares: string[];
  /** numbers after the shared reagent pass; equal to best when nothing is shared */
  afterShared?: { units: number; expectedProfit: number };
  notes: string[];
  dataAt: number;
  /** position on the list, 1 is best */
  rank?: number;
  /** the number ranked on: best expected profit minus minutes at the time rate */
  score?: number;
  /** units the shared pass handed this flip of each reagent bought at auction, for the page and the checks */
  sharedUse?: Array<{ itemId: number; units: number }>;
}

/** A candidate that did not make the list, and why. */
export interface HeldBack {
  key: string; family: Family; itemId: number; name: string; perItem: number | null; reason: string;
  /** the gate that held it back, a fixed short label the run report counts by */
  code?: string;
  sellHouseId?: number | null;
  recipeId?: number;
}

export interface FlipRunReport {
  at: number; dataAt: number; ms: number; complete: boolean; incompleteReason?: string;
  houses: number[]; items: number; recipesTried: number; flips: number;
  byFamily: Record<string, number>;
  heldBackByReason: Record<string, number>;
  suspects: string[];
}
