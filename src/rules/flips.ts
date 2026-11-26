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

/**
 * The professions Chip has (round 2 finding H3), optional JSON: ["Tailoring", "Alchemy"] or {"Tailoring": 300}. When set,
 * a sub craft in a profession he lacks (or above his skill) is bought instead when anything sells it; the recipe on the
 * card is never blocked, it can be trained. Unset: every sub craft is used and listed on the card.
 */
export const MY_PROFESSIONS_SETTING = 'my_professions';

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
 * Learning: an auction sale is not ranked until its product has at least 6 hours of watched sales. One hour of
 * differencing multiplied out to a day is noise (round 1 independent test, finding H1). Held back with code learning.
 * The same 6 hours src/analysis/history.ts uses as its floor for projecting a day.
 */
export const LEARNING_HOURS = 6;

/**
 * The cautious (low) sales estimate when sale counting gives none: sales are counted in sale EVENTS (vanished
 * listings), not units, since one buyer taking a stack of 20 is one event. The low estimate is the one sided 95
 * percent Poisson lower bound on the event count, times the mean units per event, spread over the hours watched
 * (at least 6). Round 1 finding H1.
 */
export const LOW_ESTIMATE = { confidence: 0.95, minHours: 6 };

/**
 * The chance a unit sells overnight: sale events over the night are Poisson with a mean from the middle estimate,
 * less the new units others post under Chip overnight (measured, never guessed), each event taking the mean units per
 * event. A unit sells when enough events reach it in the queue (round 1 finding H4). Units with under this chance are
 * not walked further.
 */
export const SELL_CHANCE = { negligible: 0.001 };

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

/**
 * Vendor sales (round 2 finding M3). Forever's vendor rates are unverified, and the market shows thousands of crafted
 * units posted at exactly the vendor price, so a vendor flip needs at least 5c and 5 percent of the vendor price per
 * unit of margin, or it is held back. A vendor price that comes only from Classic data (items.data_source classic1x)
 * is never ranked on.
 */
export const VENDOR_MARGIN = { minCopper: 5, minShare: 0.05 };
export const vendorMargin = (vendorPrice: number) => Math.max(VENDOR_MARGIN.minCopper, vendorPrice * VENDOR_MARGIN.minShare);

/** Gates (plan section 6). Strength stays evidence plus a show gate at 40, the same as the Now page (PRICE.showAt). */
export const FLIP_GATES = { minSalesPerDay: 1, strengthShowAt: PRICE.showAt };

/**
 * Risk (plan section 6, tightened by round 1 finding H3). Bad case: the price falls to its 3 day low AND only half of
 * the units expected to sell actually sell. Until 72 hours of floors are watched the low is assumed 25 percent under
 * the claim, and an observed low is used only when it is lower. Unsold units are salvaged at the vendor price and lose
 * their deposit. High when the bad case loses more than the flip is expected to make, medium when it loses more than
 * half of it, low otherwise. A price war: the floor fell more than 10 percent this hour, or more new units are posted
 * an hour than sell. Drivers are named in plain words past these first guess thresholds.
 */
export const RISK = { unknownLowDrop: 0.25, lowCoverHours: 72, jumpyCv: 0.25, fewSales: 10, thinSupplyShare: 0.5, priceWarDrop: 0.1 };

/**
 * New listings that compete with Chip overnight (round 2 finding H2): only units other sellers posted at or under his
 * own post price, read from the raw publishes of the last 24 hours, and only once 6 hours of publishes were watched
 * (the same 6 hours as LEARNING_HOURS). Before that new posts are not measured: 0 is used and the card says so.
 */
export const NEW_POSTS = { minHours: 6, windowHours: 24 };

/** Bad case: only this share of the units expected to sell actually sell (coordinator decision, round 1 H3). */
export const SALES_SHORTFALL = 0.5;

/**
 * What an unsold unit is worth the next morning (coordinator decision, round 2). A product with proven demand (the low
 * estimate sells at least 1 a day) is not lost when it does not sell overnight: Chip relists it. Its carryover value is
 * the net at the price of the case being priced (the expected post price for expected profit, the bad case price for
 * the bad case) minus `relistDeposits` more deposits for posting it again, never below what a vendor pays. Without
 * proven demand an unsold unit is worth only the vendor price (0 when no vendor buys it). In both cases the deposit
 * paid tonight is lost on top. Carryover covers at most `days` days of the low estimate (units past what one more day
 * can sell are worth the vendor price), so a thin market never turns every unsold unit into a near sale and the best
 * amount stays tied to demand. A first rule, unverified until the backtest follows unsold units into the next day.
 */
export const CARRYOVER = { minLowPerDay: 1, relistDeposits: 1, days: 1 };

/**
 * Fresh data: a run whose newest snapshot of one of Chip's houses is older than 2 hours is incomplete, never a
 * list built from stale prices (round 1 finding M1). Blizzard publishes about hourly.
 */
export const FRESH_HOURS = 2;

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

/**
 * Tools a recipe needs to be crafted, by recipe name, when the game tables this build reads do not say (round 2 finding
 * M4). Classic knowledge, unverified in Forever: Refined Deeprock Salt is made with a Salt Shaker.
 */
export const KNOWN_TOOLS: Record<string, string> = { 'Refined Deeprock Salt': 'Salt Shaker' };

/** A limited stock vendor is assumed to hold one bundle until stock sizes are recorded (EG Link has no counts). */
export const VENDOR_LIMITED_BUNDLES = 1;

/** Alliance usable vendor standings: Friendly (5) or lower, the same rule as src/analysis/prices.ts. */
export const VENDOR_MAX_STANDING = 5;

/** Cheap listing: the existing O3 rule, a listing at least 30 percent under the typical floor (src/rules/thresholds.ts). */
export { UNDERPRICED as CHEAP_LISTING } from './thresholds.ts';
