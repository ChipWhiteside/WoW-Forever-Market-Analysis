import { money } from '../format/money.ts';
import { deposit, netPerUnit } from '../rules/fees.ts';
import { vendorMargin, CARRYOVER, FLOOR_DRIFT, CRAFT_SESSION_MINUTES_DEFAULT, EFFORT, LISTING_HOURS, MAX_UNITS, RISK, SALES_SHORTFALL, SMALL_QUANTITY } from '../rules/flips.ts';
import { AUCTION_HOUSES } from '../datasets/places.ts';
import type { Market, TraceEntry } from './market.ts';
import { overnightQueue, type Queue } from './sellBook.ts';
import type { FlipItem, FlipRecipe, FlipInputs } from './inputs.ts';
import type { Family, FlipLeg, HouseRef, QuantityOption, Risk, SellQuote } from './types.ts';

/**
 * Expected profit if Chip acts now, at every quantity, from one walk of the cost book.
 *
 * For N units over the overnight horizon with no relisting:
 *   expected(N) = sold(N) x net each + worth of the N - sold(N) unsold units - (N - sold(N)) x deposit lost - cost(N) - minutes(N) x time rate
 * where an unsold unit is worth its carryover when the product has proven demand (relisted next day: the net at the
 * case's price less one more deposit, never under the vendor price), for as many units as one more day of the low
 * estimate can take, and what a vendor pays for the rest (0 when none does; never the reagents' value). The bad case
 * uses the same rule at the bad case price (unsoldWorth, CARRYOVER).
 * P_k is the chance unit k sells overnight: sale events are Poisson and unit k sells when enough of them arrive to
 * clear everything ahead of it and reach it (sellBook.overnightQueue, round 1 finding H4). P_k falls smoothly with k,
 * so big deposits pull the best amount below the queue's capacity. sold(N) = sum of P_k.
 * cost(N) is the real cost of the first N units: each one walks the reagent listings further,
 * plus whatever was paid for but not used (the rest of a vendor bundle or of the last craft's yield).
 */
export interface Candidate {
  key: string;
  family: Family;
  itemId: number;
  name: string;
  recipe?: FlipRecipe;
  /** null: sells to any vendor */
  sellHouse: HouseRef | null;
  quote: SellQuote;
  /** get the next batch of the product (one craft, one unit); null when nothing more can be had */
  acquire(m: Market, trace: TraceEntry[]): { cost: number; units: number } | null;
  /** houses this flip may buy on, for the trip minutes */
  buyHouseIds: number[];
}

interface Step { units: number; cost: number; cumUnits: number; cumCost: number; waste: number; traceEnd: number; markAfter: number; buyMinutes: number; castMinutes: number }

export interface Walk { steps: Step[]; trace: TraceEntry[]; exhausted: boolean; startMark: number }

export interface Evaluation {
  walk: Walk;
  /** units expected to sell overnight if Chip posted without limit (the sum of every queue position's chance) */
  cap: number;
  depositEach: number;
  maxN: number;
  goldCapped: boolean;
  /** the best quantity stopped at one crafting session; more would still pay */
  sessionCapped: boolean;
  firstUnitCost: number | null;
  options: QuantityOption[];
  best: QuantityOption | null;
  bestStep: number;
  /** the numbers at any quantity from 1 to maxN, for the checks and any extra row the page wants */
  at(n: number): QuantityOption;
}

/** Stacks only when the game says so: an unknown stack size is treated as one per listing (round 2 finding L1). */
const isStackable = (it: FlipItem | undefined) => it?.stackSize != null && it.stackSize > 1;

/** Incremental effort: minutes to buy and craft everything in the trace so far (posting and selling are added per N). */
class Effort {
  private auctionItems = new Set<string>();
  private listings = new Map<string, Set<number>>();
  private vendorItems = new Set<string>();
  private npcs = new Set<number>();
  private houses = new Set<number>();
  minutes = 0;
  /** the casting part of minutes */
  castMinutes = 0;
  constructor(private inputs: FlipInputs, private recipes: Map<number, FlipRecipe>, private sellHouseId: number | null) {}
  add(e: TraceEntry): void {
    if (e.source === 'auction') {
      const k = `${e.houseId}:${e.itemId}`;
      if (!this.auctionItems.has(k)) { this.auctionItems.add(k); this.minutes += EFFORT.auctionItemMin; this.listings.set(k, new Set()); }
      const ls = this.listings.get(k)!;
      if (e.listingId != null && !ls.has(e.listingId)) {
        ls.add(e.listingId);
        if (ls.size > 1 && !isStackable(this.inputs.items.get(e.itemId))) this.minutes += EFFORT.auctionListingMin;
      }
      if (e.houseId != null && !this.houses.has(e.houseId)) {
        this.houses.add(e.houseId);
        const away = this.sellHouseId != null ? e.houseId !== this.sellHouseId : this.houses.size > 1;
        if (away) this.minutes += EFFORT.houseTripMin;
      }
    } else if (e.source === 'vendor') {
      const k = `${e.vendor!.npcId}:${e.itemId}`;
      if (!this.vendorItems.has(k)) { this.vendorItems.add(k); this.minutes += EFFORT.vendorItemMin; }
      if (!this.npcs.has(e.vendor!.npcId)) { this.npcs.add(e.vendor!.npcId); this.minutes += EFFORT.vendorTripMin; }
    } else {
      const r = this.recipes.get(e.recipeId!);
      const cast = ((r?.castMs ?? EFFORT.castMsFallback) || EFFORT.castMsFallback) / 60000;
      this.minutes += cast; this.castMinutes += cast;
    }
  }
}

/**
 * Walk the cost book for one candidate: acquire batches until `limit` units, until nothing more can be had, or until
 * `stop` says further units cannot pay. The market is left changed; the caller rolls back to walk.startMark (a
 * standalone price) or to a step's markAfter (the shared pass keeps what it used).
 */
export function walk(c: Candidate, m: Market, inputs: FlipInputs, recipes: Map<number, FlipRecipe>, limit: number, stop: (unitCost: number, cumUnits: number) => boolean): Walk {
  const startMark = m.mark();
  const wasteStart = m.waste;
  const trace: TraceEntry[] = [];
  const effort = new Effort(inputs, recipes, c.sellHouse?.id ?? null);
  const steps: Step[] = [];
  let cumUnits = 0, cumCost = 0, exhausted = false, seen = 0;
  while (cumUnits < limit) {
    const got = c.acquire(m, trace);
    if (!got) { exhausted = true; break; }
    cumUnits += got.units; cumCost += got.cost;
    for (; seen < trace.length; seen++) effort.add(trace[seen]!);
    steps.push({ units: got.units, cost: got.cost, cumUnits, cumCost, waste: m.waste - wasteStart, traceEnd: trace.length, markAfter: m.mark(), buyMinutes: effort.minutes, castMinutes: effort.castMinutes });
    if (stop(got.cost / got.units, cumUnits)) break;
  }
  return { steps, trace, exhausted, startMark };
}

/** Index of the first step that reaches N units. */
function stepFor(w: Walk, n: number): number {
  let lo = 0, hi = w.steps.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (w.steps[mid]!.cumUnits >= n) hi = mid; else lo = mid + 1; }
  return lo;
}

export interface EvalOptions { capUsed: number; gold: number | null; timeRate: number; horizonHours: number; craftSessionMinutes?: number }

/**
 * Expected units sold at each quantity N: the chances of the N queue positions Chip takes. Usually those are the N
 * positions right behind the units ahead; a flip that buys some of the units ahead itself (cheap listing) leaves the
 * rest of them in front of its own (round 1 finding M3). A vendor sells everything.
 */
export function soldCurve(q: SellQuote, queue: Queue, used: number, maxUnits: number): { soldAt(n: number): number; lastUseful: number; cap: number } {
  if (q.houseId == null) return { soldAt: n => n, lastUseful: Infinity, cap: Infinity };
  const own = Math.max(0, q.ownAhead ?? 0);
  const baseAt = (n: number) => Math.max(0, q.ahead + used - Math.min(n, own));
  const baseMin = baseAt(own);
  const top = Math.max(0, Math.min(queue.lastPos, baseAt(0) + maxUnits));
  // prefix sums of the chances over positions 1..top; past lastPos every chance is 0
  const pre = new Float64Array(top + 1);
  for (let p = 1; p <= top; p++) pre[p] = pre[p - 1]! + queue.at(p);
  const sumTo = (p: number) => pre[Math.min(Math.max(0, p), top)]!;
  const soldAt = (n: number) => sumTo(baseAt(n) + n) - sumTo(baseAt(n));
  return { soldAt, lastUseful: Math.max(0, queue.lastPos - baseMin), cap: sumTo(queue.lastPos) - sumTo(baseMin) };
}

export function evaluate(c: Candidate, m: Market, inputs: FlipInputs, recipes: Map<number, FlipRecipe>, o: EvalOptions): Evaluation {
  const q = c.quote;
  const toVendor = q.houseId == null;
  const queue = overnightQueue(q, o.horizonHours);
  const sellItem = inputs.items.get(c.itemId);
  const depositEach = toVendor ? 0 : deposit(c.sellHouse!.faction, sellItem?.sellPrice, 1, LISTING_HOURS);
  const net = q.netEach;
  // Auction sales: walk to the larger of the small quantity and the last position with a real chance of selling by the
  // end of tomorrow when unsold units carry over (CARRYOVER), else tonight. Vendor sales: walk while units clear the
  // vendor margin.
  const probe = soldCurve(q, queue, o.capUsed, MAX_UNITS);
  const carries = carryover(q);
  // Tomorrow's queue: the next 24 hours of sale events, after whatever was ahead of Chip tonight and is not cleared by
  // tonight's events. His relisted units take the next places in it.
  const queue24 = carries ? overnightQueue(q, CARRYOVER.tomorrowHours) : null;
  const aheadTomorrow = carries ? Math.max(0, q.ahead + o.capUsed - queue.meanEvents * queue.unitsPerEvent) : 0;
  // The bad case clears the units ahead at its own rate: half of tonight's expected sales (round 6, low finding 3).
  const aheadTomorrowBad = carries ? Math.max(0, q.ahead + o.capUsed - SALES_SHORTFALL * queue.meanEvents * queue.unitsPerEvent) : 0;
  // Tonight's 24 hour listing is still up for the first hours of tomorrow: units sold then pay no second deposit.
  const cover = coverShare(o.horizonHours);
  const limit = toVendor ? MAX_UNITS : Math.min(MAX_UNITS, Math.max(SMALL_QUANTITY, probe.lastUseful + (queue24 ? queue24.lastPos : 0)));
  // A vendor sale only takes units that clear the vendor margin (VENDOR_MARGIN): the walk stops at the first that does not.
  const margin = toVendor ? vendorMargin(net) : 0;
  const w = walk(c, m, inputs, recipes, limit, (unit, cum) => toVendor && cum >= SMALL_QUANTITY && net - unit < margin);
  if (toVendor) {
    // When the very first step fails the margin it alone is kept, so the run holds it back as too thin (round 6, low 1).
    const cut = w.steps.findIndex(s => net - s.cost / s.units < margin);
    if (cut >= 0) w.steps.length = Math.max(1, cut);
  }
  // A last craft or vendor bundle can overshoot the limit; no row ever goes past MAX_UNITS (round 1 finding L6).
  const available = w.steps.length ? Math.min(MAX_UNITS, w.steps[w.steps.length - 1]!.cumUnits) : 0;
  const sold = probe;
  const cap = sold.cap;
  const costAt = (n: number) => { const s = w.steps[stepFor(w, n)]!; return { cost: s.cumCost + s.waste, s }; };
  // Gold on hand pays for everything bought and the deposit on every unit posted (round 1 finding H3).
  let maxN = available, goldCapped = false;
  if (o.gold != null) {
    while (maxN > 0 && costAt(maxN).cost + maxN * depositEach > o.gold) { maxN--; goldCapped = true; }
  }
  const nonStack = !isStackable(sellItem);
  const minutesAt = (n: number, s: Step) => s.buyMinutes + (toVendor ? EFFORT.vendorSellMin : EFFORT.postMin + (nonStack ? (n - 1) * EFFORT.postUnitMin : 0));
  const salvage = toVendor ? 0 : Math.max(0, sellItem?.sellPrice ?? 0);
  // What n units bring in, tonight and (carryover) tomorrow, at a price and with shortfalls (settle, below).
  const tonight = (n: number) => sold.soldAt(n);
  const tomorrowSold = queue24 ? tomorrowCurve(queue24, aheadTomorrow, limit) : () => 0;
  const tomorrowSoldBad = queue24 ? tomorrowCurve(queue24, aheadTomorrowBad, limit) : () => 0;
  // A shortfall tonight (the bad case, half sales) also leaves more of the units ahead for tomorrow.
  const revenue = (n: number, netAt: number, shortTonight = 1, shortTomorrow = 1) =>
    settle(n, tonight(n), shortTonight < 1 ? tomorrowSoldBad : tomorrowSold, netAt, salvage, depositEach, shortTonight, shortTomorrow, carries, cover);
  const expectedAt = (n: number, cost: number, s: Step) => revenue(n, net).value - cost - (minutesAt(n, s) / 60) * o.timeRate;
  const session = c.recipe ? o.craftSessionMinutes ?? CRAFT_SESSION_MINUTES_DEFAULT : Infinity;
  const option = (label: QuantityOption['label'], n: number): QuantityOption => {
    const { cost, s } = costAt(n);
    const k = sold.soldAt(n);
    const tomorrow = revenue(n, net).tomorrow;
    const minutes = minutesAt(n, s);
    const expectedProfit = Math.round(expectedAt(n, cost, s));
    const over = s.castMinutes > session + 1e-9;
    return { label, units: n, cost: Math.round(cost), expectedSold: Math.round(k * 10) / 10, soldTomorrow: Math.round(tomorrow * 10) / 10, expectedProfit, minutes: Math.round(minutes * 10) / 10,
      castMinutes: Math.round(s.castMinutes * 10) / 10,
      note: over ? `${Math.round(s.castMinutes)} minutes of crafting, more than one ${session} minute session` : undefined,
      goldPerHour: minutes > 0 ? Math.round(expectedProfit / (minutes / 60)) : null, risk: riskOf(c, inputs, n, cost, k, cap, expectedProfit, w, depositEach, (netAt, a, b) => revenue(n, netAt, a, b).value) };
  };
  const at = (n: number) => option('best', Math.max(1, Math.min(n, Math.max(1, available))));
  if (maxN <= 0) return { walk: w, cap, depositEach, maxN, goldCapped, firstUnitCost: w.steps[0] ? w.steps[0].cost / w.steps[0].units : null, sessionCapped: false, options: [], best: null, bestStep: -1, at };
  // Best (coordinator decision after round 4): the quantity with the most expected profit among those whose risk is
  // not high, inside one crafting session for a craft (at least one craft); ties go to fewer units. When no quantity
  // qualifies, the smallest with a positive expected profit, and the flip stays high risk. The quantity with the most
  // expected profit regardless of risk (inside the session) becomes the "most" row when larger: "most profit, higher
  // risk". Unbounded by the session: freeN, for the session note and a vendor sale's "most" row.
  const badNet = badCaseNet(c, q);
  const isHigh = (n: number, cost: number, e: number) => {
    if (toVendor) return false;
    const loss = Math.max(0, cost - revenue(n, badNet, SALES_SHORTFALL, CARRYOVER.badShare).value);
    return Math.round(loss) > Math.round(e) || tonight(n) < n * RISK.tonightHigh;
  };
  let bestN = 0, bestE = -Infinity, topN = 1, topE = -Infinity, freeN = 1, freeE = -Infinity, firstPositive = 0;
  for (let n = 1; n <= maxN; n++) {
    const { cost, s } = costAt(n);
    const e = expectedAt(n, cost, s);
    if (e > freeE + 1e-9) { freeE = e; freeN = n; }
    const inSession = n === 1 || s.castMinutes <= session + 1e-9;
    if (!inSession) continue;
    if (e > topE + 1e-9) { topE = e; topN = n; }
    if (!firstPositive && Math.round(e) > 0) firstPositive = n;
    if (e > bestE + 1e-9 && !isHigh(n, cost, e)) { bestE = e; bestN = n; }
  }
  const riskCapped = bestN === 0 || bestN < topN;
  if (bestN === 0) bestN = firstPositive || topN;
  const sessionCapped = freeN > topN;
  // The most: the most expected profit regardless of risk when larger than the best (an auction), or all that still
  // pays (a vendor), never past MAX_UNITS.
  const mostN = Math.min(MAX_UNITS, toVendor ? Math.max(bestN, freeN) : Math.max(bestN, topN));
  const most = option('most', mostN);
  if (!toVendor && mostN > bestN && riskCapped) most.note = most.note ? `most profit, higher risk; ${most.note}` : 'most profit, higher risk';
  // The small row stays inside one crafting session too, like the best and the most (round 6, low finding 2).
  let smallN = Math.min(SMALL_QUANTITY, maxN);
  while (smallN > 1 && costAt(smallN).s.castMinutes > session + 1e-9) smallN--;
  const options = [option('small', smallN), option('best', bestN), most];
  return { walk: w, cap, depositEach, maxN, goldCapped, sessionCapped, firstUnitCost: w.steps[0]!.cost / w.steps[0]!.units, options, best: options[1]!, bestStep: stepFor(w, bestN), at };
}

/**
 * Risk at one quantity (round 1 finding H3). Bad case: the price falls to its 3 day low (a 25 percent drop until 72
 * hours of floors are watched; a lower low seen is used) AND only half of the units expected to sell actually sell.
 * Unsold units are worth their carryover at the bad case price (proven demand) or the vendor price, and lose their
 * deposit. Gold at stake counts every deposit.
 * High when the bad case loses more than the flip is expected to make, medium when it loses more than half of it.
 */
function riskOf(c: Candidate, inputs: FlipInputs, n: number, cost: number, sold: number, cap: number, expected: number, w: Walk, depositEach: number,
  revenueAt: (netAt: number, shortTonight: number, shortTomorrow: number) => number): Risk {
  const q = c.quote;
  const drivers: string[] = [];
  let netBad = q.netEach, daysToSell: number | null = 0;
  if (q.houseId != null) {
    const covered = (q.lowCoverHours ?? q.hoursWatched) >= RISK.lowCoverHours;
    netBad = badCaseNet(c, q);
    daysToSell = q.salesPerDayLow ? Math.round(((q.ahead + n) / q.salesPerDayLow) * 10) / 10 : null;
    if ((q.cv ?? 0) > RISK.jumpyCv) drivers.push('the price jumps around');
    if ((q.provenSales ?? 0) < RISK.fewSales) drivers.push('few sales seen');
    if (q.ahead > 0 && q.ahead >= (q.salesPerDayLow ?? 0) * (inputs.settings.horizonHours / 24)) drivers.push('many units listed ahead of you');
    // The floor itself rose over 10 percent this hour: the price just jumped. A sweep above the claim alone is said as it is.
    if (q.floorChange1h != null && q.floorChange1h > RISK.priceJumpRise) drivers.push('the price just jumped');
    else if (q.rising && q.upTo != null) drivers.push(`buyers paid up to ${money(q.upTo)} this hour, above the price used`);
    const war = priceWar(q);
    if (war) drivers.push(war);
    if (n > cap) drivers.push('more units than sell overnight');
    if (!covered) drivers.push('under 3 days of prices seen, a 25% drop assumed for the bad case');
    if (c.sellHouse!.faction === 'blackwater') drivers.push('Blackwater deposit not verified yet');
  }
  // Thin supply: the units bought use most of what is listed for a reagent.
  const s = w.steps[stepFor(w, n)];
  if (s) {
    const used = new Map<string, number>();
    for (let i = 0; i < s.traceEnd; i++) { const e = w.trace[i]!; if (e.source === 'auction') used.set(`${e.houseId}:${e.itemId}`, (used.get(`${e.houseId}:${e.itemId}`) ?? 0) + 1); }
    for (const [k, u] of used) {
      const [h, it] = k.split(':').map(Number) as [number, number];
      const listed = (inputs.listings.get(h)?.get(it) ?? []).reduce((a, l) => a + l.quantity, 0);
      if (listed && u / listed > RISK.thinSupplyShare) { drivers.push(`thin supply of ${inputs.items.get(it)?.name ?? `item ${it}`}`); break; }
    }
  }
  // Bad case: the bad price, half tonight's expected sales, and half of tomorrow's (carryover halved, round 2 H1).
  // A vendor buys every unit at a fixed price: no shortfall and no price drop.
  const auction = q.houseId != null;
  const badCaseLoss = Math.max(0, Math.round(cost - revenueAt(netBad, auction ? SALES_SHORTFALL : 1, auction ? CARRYOVER.badShare : 1)));
  const halfSalesProfit = Math.round(revenueAt(q.netEach, auction ? SALES_SHORTFALL : 1, auction ? CARRYOVER.badShare : 1) - cost);
  let level: Risk['level'] = badCaseLoss > expected ? 'high' : badCaseLoss > expected / 2 ? 'medium' : 'low';
  // Units that mostly do not sell tonight are risky whatever tomorrow promises (round 2 H1).
  if (auction && sold < n * RISK.tonightHigh) level = 'high';
  else if (auction && sold < n * RISK.tonightMedium && level === 'low') level = 'medium';
  if (auction && sold < n * RISK.tonightMedium) drivers.push(`only ${Math.round(sold * 10) / 10} of ${n} expected to sell tonight`);
  return { atStake: Math.round(cost + n * depositEach), badCaseLoss, halfSalesProfit, deposits: Math.round(n * depositEach), daysToSell, level, drivers };
}

/**
 * The net per unit in the bad case: the price at its 3 day low, or a 25 percent drop until 72 hours of floors are
 * watched (a lower low seen is used), never above Chip's post price. A vendor's price is fixed.
 */
export function badCaseNet(c: Candidate, q: SellQuote): number {
  if (q.houseId == null) return q.netEach;
  const drop = Math.round(q.claimPrice * (1 - RISK.unknownLowDrop));
  const covered = (q.lowCoverHours ?? q.hoursWatched) >= RISK.lowCoverHours;
  const low = covered && q.low3d != null ? q.low3d : Math.min(q.low3d ?? Infinity, drop);
  return netPerUnit(c.sellHouse!.faction, Math.min(low, q.undercutPrice));
}

/** Whether unsold units carry over to tomorrow: an auction sale of a product with proven demand (CARRYOVER). */
export const carryover = (q: SellQuote) => q.houseId != null && (q.salesPerDayLow ?? 0) >= CARRYOVER.minLowPerDay;

/**
 * Units expected to sell tomorrow when `left` are relisted: the chances of the queue positions right after the units
 * still ahead, over the next 24 hours (fractional units take their share of the next position).
 */
export function tomorrowCurve(queue24: Queue, aheadTomorrow: number, maxUnits: number): (left: number) => number {
  const base = Math.floor(aheadTomorrow);
  const top = Math.max(0, Math.min(maxUnits, queue24.lastPos - base) + 1);
  const pre = new Float64Array(top + 1);
  for (let k = 1; k <= top; k++) pre[k] = pre[k - 1]! + queue24.at(base + k);
  return (left: number) => {
    if (left <= 0) return 0;
    const whole = Math.floor(left), frac = left - whole;
    const at = (k: number) => pre[Math.min(k, top)]!;
    return at(whole) + frac * (at(whole + 1) - at(whole));
  };
}

/**
 * Share of tomorrow's window that tonight's listing still covers: a 24 hour listing posted for a 10 hour night is up for
 * 14 of tomorrow's 24 hours (round 6, low finding 4). Sale events are spread evenly over the window, so that share of
 * tomorrow's sales happens before any relisting.
 */
export const coverShare = (horizonHours: number) => Math.min(1, Math.max(0, (LISTING_HOURS - horizonHours) / CARRYOVER.tomorrowHours));

/**
 * What n posted units bring in (before their cost), round 2 finding H1, the round 5 fix and round 6 (low finding 4).
 * `tonight` units are expected to sell tonight; the rest sell tomorrow through tomorrow's queue (`tomorrowSold` of
 * however many are left). Tonight's listing is still up for the `cover` share of tomorrow, so those sales pay no
 * second deposit; the units still unsold when it expires lose their deposit and are relisted for one more, which is
 * lost again on whatever is still unsold at the end. The best of three:
 *   vendor now: sold tonight x net + unsold x (salvage - deposit)
 *   let it run out: sold tonight x net + sold while still up x net + the rest x (salvage - deposit)
 *   relist: sold tonight x net + sold tomorrow x net - unsold at expiry x deposit - still unsold x (deposit - salvage)
 * (with `cover` 1 the listing covers all of tomorrow: no relisting, one deposit lost on what is still unsold).
 * `shortTonight` scales tonight's sales and `shortTomorrow` tomorrow's (1 expected; the bad case halves both, and the
 * units tonight's shortfall leaves go to tomorrow's queue). Returns the value and the units sold tomorrow.
 */
export function settle(n: number, tonight: number, tomorrowSold: (left: number) => number, netAt: number, salvage: number, deposit: number,
  shortTonight: number, shortTomorrow: number, carries: boolean, cover = 0): { value: number; tomorrow: number } {
  const s1 = Math.min(n, tonight * shortTonight);
  const left = n - s1;
  const keep = s1 * netAt + left * (salvage - deposit);
  if (!carries || left <= 0) return { value: keep, tomorrow: 0 };
  const s2 = Math.min(left, tomorrowSold(left) * shortTomorrow);
  const end = left - s2;
  let best = { value: keep, tomorrow: 0 };
  const consider = (value: number, tomorrow: number) => { if (value > best.value) best = { value, tomorrow }; };
  if (cover >= 1) { consider(s1 * netAt + s2 * netAt + end * (salvage - deposit), s2); return best; }
  const sUp = s2 * Math.max(0, cover);
  if (sUp > 0) consider(s1 * netAt + sUp * netAt + (left - sUp) * (salvage - deposit), sUp);
  consider(s1 * netAt + s2 * netAt - (left - sUp) * deposit - end * deposit + end * salvage, s2);
  return best;
}

/**
 * A price war, named as a risk, never read as demand: the floor fell more than 10 percent since the last publish, the
 * fitted floor fell 10 percent or more across the window (FLOOR_DRIFT: a slow grind never trips the hourly check), or
 * more new units are posted an hour than sell an hour (middle estimate).
 */
export function priceWar(q: SellQuote): string | null {
  if (q.houseId == null) return null;
  const fell = q.floorChange1h != null && q.floorChange1h <= -RISK.priceWarDrop;
  const slid = q.floorFall != null && q.floorFall >= FLOOR_DRIFT.warFall;
  const soldPerHour = (q.salesPerDayMid ?? 0) / 24;
  const flood = q.newPerHour > soldPerHour && q.newPerHour > 0;
  if (!fell && !slid && !flood) return null;
  const perHour = Math.round(fell && q.newLastHour != null ? q.newLastHour : q.newPerHour);
  if (fell) return `price war: floor fell ${Math.round(-q.floorChange1h! * 100)}% this hour, ${perHour} new listings an hour`;
  if (slid) return `price war: floor fell ${Math.round(q.floorFall! * 100)}% over the last ${Math.round(q.floorSpanHours ?? 0)} hours, ${perHour} new listings an hour`;
  return `price war: ${perHour} new listings an hour, more than the ${Math.round(soldPerHour * 10) / 10} that sell`;
}

/** The note on a cooldown sub craft charged at its product's auction net (system review round 1, J3). */
export const COOLDOWN_OPPORTUNITY = 'valued at what it sells for on the auction house, since it spends the cooldown';

/** The buy legs for the first `traceEnd` trace entries: where to buy what, how many, at what average price, and the crafts. */
export function legsOf(trace: TraceEntry[], traceEnd: number, inputs: FlipInputs, recipes: Map<number, FlipRecipe>): FlipLeg[] {
  const buys = new Map<string, FlipLeg & { total: number }>();
  const crafts = new Map<number, FlipLeg & { total: number; depth: number }>();
  const houseName = (id: number) => inputs.houses.find(h => h.id === id);
  for (let i = 0; i < traceEnd; i++) {
    const e = trace[i]!;
    const name = inputs.items.get(e.itemId)?.name ?? `Item ${e.itemId}`;
    if (e.source === 'craft') {
      const r = recipes.get(e.recipeId!);
      const g = crafts.get(e.recipeId!) ?? { kind: 'craft' as const, itemId: e.itemId, name, units: 0, unitPrice: 0, who: r ? `${r.profession}: ${r.name}` : 'craft', places: [], total: 0, depth: e.depth };
      g.units += e.units; g.total += e.cost; g.depth = Math.min(g.depth, e.depth); crafts.set(e.recipeId!, g);
      if (e.opportunity) g.note = COOLDOWN_OPPORTUNITY;
      continue;
    }
    const k = e.source === 'auction' ? `a:${e.houseId}:${e.itemId}` : `v:${e.vendor!.npcId}:${e.itemId}`;
    let g = buys.get(k);
    if (!g) {
      if (e.source === 'auction') {
        const h = houseName(e.houseId!);
        g = { kind: 'auction', itemId: e.itemId, name, units: 0, unitPrice: 0, who: `${h?.faction === 'blackwater' ? 'Blackwater' : 'Alliance'} auction house`, houseId: e.houseId,
          places: AUCTION_HOUSES[h?.faction === 'blackwater' ? 'blackwater' : 'alliance'], total: 0 };
      } else {
        const v = e.vendor!;
        g = { kind: 'vendor', itemId: e.itemId, name, units: 0, unitPrice: 0, who: v.npcName, places: v.places, total: 0,
          note: [v.bundle > 1 ? `sold ${v.bundle} at a time` : null, v.limited ? 'limited stock' : null].filter(Boolean).join(', ') || undefined };
      }
      buys.set(k, g);
    }
    g.units += e.units; g.total += e.cost;
  }
  const fin = <T extends FlipLeg & { total: number }>(g: T): FlipLeg => {
    const { total, ...leg } = g as T & { depth?: number };
    delete (leg as { depth?: number }).depth;
    return { ...leg, unitPrice: Math.round(total / Math.max(1, g.units)) };
  };
  return [...[...buys.values()].map(fin), ...[...crafts.values()].sort((a, b) => b.depth - a.depth).map(fin)];
}

/** Units bought at auction per item in the first `traceEnd` entries (the shared pass checks these against the listings). */
export function auctionUse(trace: TraceEntry[], traceEnd: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < traceEnd; i++) { const e = trace[i]!; if (e.source === 'auction') m.set(e.itemId, (m.get(e.itemId) ?? 0) + e.units); }
  return m;
}
