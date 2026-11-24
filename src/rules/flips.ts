/**
 * PROTECTED. The flip engine's constants (docs/flip-plan.md, approved by Chip on November 24).
 * Every number says where it came from. Most are first guesses that the paper trade backtest will tune;
 * the overnight loop may propose changes here and only Chip approves them.
 */
import type { Duration } from './fees.ts';
import { PRICE } from './price.ts';

/** Chip decision 8: he lists, then sleeps about 10 hours, with no relisting in that time. */
export const HORIZON_HOURS = 10;

/**
 * The listing length that covers the night: 8 hours is shorter than the 10 hour horizon, so 24.
 * The deposit on every unit unsold at the end of the night counts as lost (decision 8).
 */
export const LISTING_HOURS: Duration = 24;

/** Copper per hour of Chip's time. Decision 8: 0 by default, minutes are shown, never charged. Settings key time_rate. */
export const TIME_RATE_DEFAULT = 0;
export const TIME_RATE_SETTING = 'time_rate';
/** Gold on hand, in gold, optional. Settings key gold_on_hand (the same key the Now page uses). */
export const GOLD_SETTING = 'gold_on_hand';

/**
 * One crafting session per flip, in minutes of casting. Chip crafts, then lists and sleeps: 5,000 casts is about
 * 4 hours, not a realistic evening. The best quantity of a craft stays inside one session; the "most" option may go
 * past it and says so. Settings key craft_session_minutes. Coordinator decision, November 24.
 */
export const CRAFT_SESSION_MINUTES_DEFAULT = 30;
export const CRAFT_SESSION_SETTING = 'craft_session_minutes';

/** Plan section 6, quantity table: "for example 10, the best amount, and the most the market can take". */
export const SMALL_QUANTITY = 10;

/**
 * Most units one flip is ever walked to. A safety bound for vendor sales, which have no market limit.
 * Large enough that the plan's "2,000 crafts for 2c" scenario is shown whole.
 */
export const MAX_UNITS = 5000;

/** Deepest recipe tree walked, the same guard as src/craft/makeOrBuy.ts. */
export const MAX_CRAFT_DEPTH = 4;

/** Chip's Alliance house, proven from his screenshots (verification B11). Used alone until he pins houses. */
export const DEFAULT_HOUSE = 111;

/**
 * The cautious sales estimate when sale counting gives no low estimate (Demand.lowPerDay missing).
 * Sales seen are treated as a Poisson count n; the low estimate is n minus 1.645 square roots of n
 * (one sided 95 percent, normal approximation), spread over at least 6 hours, the same floor
 * src/analysis/history.ts uses so one early sale never reads as 24 a day.
 */
export const LOW_ESTIMATE = { z: 1.645, minHours: 6 };

/**
 * New units other sellers post under Chip overnight, as a share of the middle sales estimate, used only when sale
 * counting gives no newPerDay. A guess until the backtest measures it; deliberately cautious.
 */
export const NEW_POSTS_FALLBACK_SHARE = 0.25;

/**
 * One typical undercut: the median gap between the cheapest distinct price levels on the ladder, never under 1c and
 * never over 5 percent of the price. With a single price level nobody is undercutting yet, so 1 percent is assumed.
 * First guesses (plan section 6, "the sell price assumes one typical undercut").
 */
export const UNDERCUT = { levels: 6, maxShare: 0.05, singleLevelShare: 0.01, minCopper: 1 };

/**
 * The margin gate: profit each must beat this item's own price wobble, one standard deviation of its hourly floor
 * over 3 days (Demand.floorCv times the claimed price). Plan section 6, gate 2: not a flat percentage.
 * With no steadiness reading yet, a 10 percent wobble is assumed.
 */
export const WOBBLE = { unknownCv: 0.1, minCopper: 1 };

/** Gates (plan section 6). Strength stays evidence plus a show gate at 40, the same as the Now page (PRICE.showAt). */
export const FLIP_GATES = { minSalesPerDay: 1, strengthShowAt: PRICE.showAt };

/**
 * Risk (plan section 6). Bad case: the price falls to its 3 day low; with no low recorded it is assumed 25 percent
 * lower. Drivers are named in plain words past these first guess thresholds.
 */
export const RISK = { unknownLowDrop: 0.25, jumpyCv: 0.25, fewSales: 10, thinSupplyShare: 0.5 };

/**
 * Effort minutes, shown on every card and charged only at the time rate (0 by default). First guesses until Chip
 * times a craft batch and a posting session (plan section 10, item 4).
 */
export const EFFORT = {
  /** find and buy one reagent at the auction house */
  auctionItemMin: 1,
  /** each extra listing clicked for an item that does not stack (equipment buys one by one) */
  auctionListingMin: 0.1,
  /** buy one item from a vendor */
  vendorItemMin: 0.5,
  /** walk or fly to one vendor */
  vendorTripMin: 5,
  /** craft cast time when the recipe has none recorded, a typical classic tradeskill cast */
  castMsFallback: 3000,
  /** post one product */
  postMin: 1,
  /** each extra unit posted for an item that does not stack */
  postUnitMin: 0.1,
  /** sell to a vendor */
  vendorSellMin: 1,
  /** travel between Stormwind and Booty Bay */
  houseTripMin: 15,
};

/**
 * Repeatable: a vendor that refills, or auction supply at least 3 times what the best quantity uses.
 * Everything else is one opening (plan section 5).
 */
export const REPEATABLE = { depthMultiple: 3 };

/**
 * Opening 'new' when the key was not in flip_history in the last 1.6 hours (one publish gap, the same tolerance as
 * MAX_DIFF_HOURS in src/engine/collector.ts). Trends read 72 hours of flip_history.
 */
export const OPENING = { newWindowHours: 1.6, trendHours: 72 };

/**
 * Old catalogs carry no cooldowns at all. Until the game tables fill recipes.cooldown_ms, every "Transmute:" recipe
 * is assumed to share one 24 hour cooldown, so a transmute chain is never priced as if it had none
 * (plan section 3, live run: "transmute chains priced as if they had no cooldown"). Classic behaviour, unverified in Forever.
 */
export const TRANSMUTE_FALLBACK = { pattern: /^Transmute:/i, cooldownMs: 24 * 3600_000, category: -1 };

/** A limited stock vendor is assumed to hold one bundle until stock sizes are recorded (EG Link has no counts). */
export const VENDOR_LIMITED_BUNDLES = 1;

/** Alliance usable vendor standings: Friendly (5) or lower, the same rule as src/analysis/prices.ts. */
export const VENDOR_MAX_STANDING = 5;

/** Cheap listing: the existing O3 rule, a listing at least 30 percent under the typical floor (src/rules/thresholds.ts). */
export { UNDERPRICED as CHEAP_LISTING } from './thresholds.ts';
