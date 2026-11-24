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
}

export interface Risk {
  /** total gold spent to do it */
  atStake: number;
  /** loss if the price falls to its 3 day low and only the low estimate sells overnight */
  badCaseLoss: number;
  daysToSell: number | null;
  level: 'low' | 'medium' | 'high';
  drivers: string[];
}

export interface QuantityOption {
  label: 'small' | 'best' | 'most';
  units: number;
  cost: number;
  expectedSold: number;
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
  setup?: { skill: string; rank: number | null; cost: number | null; where: string | null; places: Place[] } | null;
  /** keys of higher ranked flips that use the same reagent listings, buyers or gold */
  shares: string[];
  /** numbers after the shared reagent pass; equal to best when nothing is shared */
  afterShared?: { units: number; expectedProfit: number };
  notes: string[];
  dataAt: number;
}

/** A candidate that did not make the list, and why. */
export interface HeldBack { key: string; family: Family; itemId: number; name: string; perItem: number | null; reason: string }

export interface FlipRunReport {
  at: number; dataAt: number; ms: number; complete: boolean; incompleteReason?: string;
  houses: number[]; items: number; recipesTried: number; flips: number;
  byFamily: Record<string, number>;
  heldBackByReason: Record<string, number>;
  suspects: string[];
}
