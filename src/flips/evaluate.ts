import { deposit, netPerUnit } from '../rules/fees.ts';
import { EFFORT, LISTING_HOURS, MAX_UNITS, RISK, SMALL_QUANTITY } from '../rules/flips.ts';
import { AUCTION_HOUSES } from '../datasets/places.ts';
import type { Market, TraceEntry } from './market.ts';
import { capacity } from './sellBook.ts';
import type { FlipItem, FlipRecipe, FlipInputs } from './inputs.ts';
import type { Family, FlipLeg, HouseRef, QuantityOption, Risk, SellQuote } from './types.ts';

/**
 * Expected profit if Chip acts now, at every quantity, from one walk of the cost book.
 *
 * For N units over the overnight horizon with no relisting:
 *   expected(N) = sold(N) x net each - cost(N) - (N - sold(N)) x deposit lost - minutes(N) x time rate
 * where unit k sells with chance clamp(C - (k - 1), 0, 1), so sold(N) = min(N, C), and C is the queue capacity
 * (sellBook.capacity). cost(N) is the real cost of the first N units: each one walks the reagent listings further,
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

interface Step { units: number; cost: number; cumUnits: number; cumCost: number; waste: number; traceEnd: number; markAfter: number; buyMinutes: number }

export interface Walk { steps: Step[]; trace: TraceEntry[]; exhausted: boolean; startMark: number }

export interface Evaluation {
  walk: Walk;
  cap: number;
  depositEach: number;
  maxN: number;
  goldCapped: boolean;
  firstUnitCost: number | null;
  options: QuantityOption[];
  best: QuantityOption | null;
  bestStep: number;
  /** the numbers at any quantity from 1 to maxN, for the checks and any extra row the page wants */
  at(n: number): QuantityOption;
}

const isStackable = (it: FlipItem | undefined) => it?.stackSize !== 1;

/** Incremental effort: minutes to buy and craft everything in the trace so far (posting and selling are added per N). */
class Effort {
  private auctionItems = new Set<string>();
  private listings = new Map<string, Set<number>>();
  private vendorItems = new Set<string>();
  private npcs = new Set<number>();
  private houses = new Set<number>();
  minutes = 0;
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
      this.minutes += ((r?.castMs ?? EFFORT.castMsFallback) || EFFORT.castMsFallback) / 60000;
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
    steps.push({ units: got.units, cost: got.cost, cumUnits, cumCost, waste: m.waste - wasteStart, traceEnd: trace.length, markAfter: m.mark(), buyMinutes: effort.minutes });
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

export interface EvalOptions { capUsed: number; gold: number | null; timeRate: number; horizonHours: number }

export function evaluate(c: Candidate, m: Market, inputs: FlipInputs, recipes: Map<number, FlipRecipe>, o: EvalOptions): Evaluation {
  const q = c.quote;
  const toVendor = q.houseId == null;
  const cap = capacity(q, o.horizonHours, o.capUsed);
  const sellItem = inputs.items.get(c.itemId);
  const depositEach = toVendor ? 0 : deposit(c.sellHouse!.faction, sellItem?.sellPrice, 1, LISTING_HOURS);
  const net = q.netEach;
  // Auction sales: units past what sells overnight only lose, so walk to the larger of the small quantity and the
  // capacity. Vendor sales: walk while units still cost under what the vendor pays.
  const limit = toVendor ? MAX_UNITS : Math.min(MAX_UNITS, Math.max(SMALL_QUANTITY, Math.ceil(cap)));
  const w = walk(c, m, inputs, recipes, limit, (unit, cum) => toVendor && cum >= SMALL_QUANTITY && unit >= net);
  const available = w.steps.length ? w.steps[w.steps.length - 1]!.cumUnits : 0;
  const costAt = (n: number) => { const s = w.steps[stepFor(w, n)]!; return { cost: s.cumCost + s.waste, s }; };
  let maxN = available, goldCapped = false;
  if (o.gold != null) {
    while (maxN > 0 && costAt(maxN).cost > o.gold) { maxN--; goldCapped = true; }
  }
  const nonStack = !isStackable(sellItem);
  const minutesAt = (n: number, s: Step) => s.buyMinutes + (toVendor ? EFFORT.vendorSellMin : EFFORT.postMin + (nonStack ? (n - 1) * EFFORT.postUnitMin : 0));
  const option = (label: QuantityOption['label'], n: number): QuantityOption => {
    const { cost, s } = costAt(n);
    const sold = Math.min(n, cap);
    const minutes = minutesAt(n, s);
    const expectedProfit = Math.round(sold * net - cost - (n - sold) * depositEach - (minutes / 60) * o.timeRate);
    return { label, units: n, cost: Math.round(cost), expectedSold: Math.round(sold * 10) / 10, expectedProfit, minutes: Math.round(minutes * 10) / 10,
      goldPerHour: minutes > 0 ? Math.round(expectedProfit / (minutes / 60)) : null, risk: riskOf(c, inputs, n, cost, sold, cap, depositEach, expectedProfit, w) };
  };
  const at = (n: number) => option('best', Math.max(1, Math.min(n, Math.max(1, available))));
  if (maxN <= 0) return { walk: w, cap, depositEach, maxN, goldCapped, firstUnitCost: w.steps[0] ? w.steps[0].cost / w.steps[0].units : null, options: [], best: null, bestStep: -1, at };
  // Best: the quantity with the most expected profit (ties go to fewer units).
  let bestN = 1, bestE = -Infinity;
  for (let n = 1; n <= maxN; n++) {
    const { cost, s } = costAt(n);
    const sold = Math.min(n, cap);
    const e = sold * net - cost - (n - sold) * depositEach - (minutesAt(n, s) / 60) * o.timeRate;
    if (e > bestE + 1e-9) { bestE = e; bestN = n; }
  }
  const mostN = toVendor ? bestN : Math.max(bestN, Math.min(maxN, Math.ceil(cap)));
  const options = [option('small', Math.min(SMALL_QUANTITY, maxN)), option('best', bestN), option('most', mostN)];
  return { walk: w, cap, depositEach, maxN, goldCapped, firstUnitCost: w.steps[0]!.cost / w.steps[0]!.units, options, best: options[1]!, bestStep: stepFor(w, bestN), at };
}

/**
 * Risk at one quantity. Bad case: the price falls to its 3 day low and only the low estimate of units sells; unsold
 * units are salvaged at the vendor price and lose their deposit. High when the bad case loses more than the flip is
 * expected to make, medium when it loses anything, low when even the bad case does not lose.
 */
function riskOf(c: Candidate, inputs: FlipInputs, n: number, cost: number, sold: number, cap: number, depositEach: number, expected: number, w: Walk): Risk {
  const q = c.quote;
  const item = inputs.items.get(c.itemId);
  const drivers: string[] = [];
  let netBad = q.netEach, daysToSell: number | null = 0;
  if (q.houseId != null) {
    const low = q.low3d ?? Math.round(q.claimPrice * (1 - RISK.unknownLowDrop));
    netBad = netPerUnit(c.sellHouse!.faction, Math.min(low, q.undercutPrice));
    daysToSell = q.salesPerDayLow ? Math.round(((q.ahead + n) / q.salesPerDayLow) * 10) / 10 : null;
    if ((q.cv ?? 0) > RISK.jumpyCv) drivers.push('the price jumps around');
    if ((q.provenSales ?? 0) < RISK.fewSales) drivers.push('few sales seen');
    if (q.ahead > 0 && q.ahead >= (q.salesPerDayLow ?? 0) * (inputs.settings.horizonHours / 24)) drivers.push('many units listed ahead of you');
    if (q.rising) drivers.push('the price just jumped');
    if (n > cap) drivers.push('more units than sell overnight');
    if (q.low3d == null) drivers.push('no 3 day low recorded yet');
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
  const soldBad = Math.min(n, cap);
  const salvage = item?.sellPrice ?? 0;
  const revenue = soldBad * netBad + (n - soldBad) * (salvage - depositEach);
  const badCaseLoss = Math.max(0, Math.round(cost - revenue));
  const level: Risk['level'] = badCaseLoss <= 0 ? 'low' : badCaseLoss > expected ? 'high' : 'medium';
  void sold;
  return { atStake: Math.round(cost), badCaseLoss, daysToSell, level, drivers };
}

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
