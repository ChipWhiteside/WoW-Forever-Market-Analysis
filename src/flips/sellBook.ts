import type { Listing } from '../analysis/aggregate.ts';
import { judgeSell, type DetectorContext, type HouseCtx, type ItemCtx, type VendorOffer } from '../detectors/types.ts';
import { netPerUnit } from '../rules/fees.ts';
import { FLIP_GATES, LOW_ESTIMATE, NEW_POSTS, SELL_CHANCE, UNDERCUT } from '../rules/flips.ts';
import { newPerDayAt, undercutPerDay } from './newPosts.ts';
import { poissonLowerBound, poissonTail, poissonUpper } from './poisson.ts';
import { money } from '../format/money.ts';
import type { FlipDemand, FlipInputs } from './inputs.ts';
import type { HouseRef, SellQuote } from './types.ts';

/**
 * The sell book: what the next unit nets when sold, on one of Chip's houses or to a vendor.
 * Auction prices go through judgeSell and src/rules/price.ts, so one troll listing never sets a price and the claim is
 * never above where real sales happened. Chip posts one typical undercut below the claim; the units he expects to
 * sell overnight come from a queue (overnightQueue below, and soldCurve in evaluate.ts).
 */

/**
 * The cautious units sold a day: sale counting's lowPerDay, else worked out here from sale EVENTS, never units. One
 * buyer taking a stack of 20 is one event, so the low estimate is the one sided 95 percent Poisson lower bound on the
 * events seen, times the mean units per event, over the hours watched (at least 6). Null when no event count exists:
 * the low estimate is never projected from units alone (round 1 finding H1).
 */
export function lowPerDay(d: FlipDemand | undefined): { value: number | null; derived: boolean; pending?: boolean } {
  if (!d) return { value: null, derived: false };
  if (d.lowPerDay != null && Number.isFinite(d.lowPerDay)) return { value: Math.max(0, d.lowPerDay), derived: false };
  // Sale counting ran (it reports hours watched) and has no low estimate yet: not known, never derived here around its
  // own minimum of publishes (independent sale counting test, finding 1). The flip waits as learning.
  if (d.hoursWatched != null) return { value: null, derived: false, pending: true };
  if (d.saleEvents == null || !Number.isFinite(d.saleEvents)) return { value: null, derived: true };
  const hours = Math.max(hoursWatched(d), LOW_ESTIMATE.minHours);
  const upe = d.unitsPerEvent != null && d.unitsPerEvent > 0 ? d.unitsPerEvent : 1;
  return { value: ((poissonLowerBound(d.saleEvents, LOW_ESTIMATE.confidence) * upe) / hours) * 24, derived: true };
}

/** Hours of differenced publishes behind an item's sales numbers. */
export const hoursWatched = (d: FlipDemand | undefined): number => d?.hoursWatched ?? d?.hours ?? 0;

/**
 * New units other sellers post near or under the floor a day that really compete with Chip, as measured (sale
 * counting's newPerDay, else the stored hourly counts, src/flips/inputs.ts enrichDemand). A seller who pulls a stack
 * and posts it again is not new competition, so units pulled near the floor (pulledPerDay) come off when known:
 * competing new = max(0, newPerDay - pulledPerDay). Never guessed: unmeasured reads 0 and the card says so.
 */
export function newPerDay(d: FlipDemand | undefined): { value: number; measured: boolean } {
  // the same 6 hour minimum as the learning gate (round 2 H2): one busy hour is not a night of new posts
  if (d?.newPerDay != null && Number.isFinite(d.newPerDay) && hoursWatched(d) >= NEW_POSTS.minHours - 0.1) {
    const pulled = d.pulledPerDay != null && Number.isFinite(d.pulledPerDay) ? d.pulledPerDay : 0;
    return { value: Math.max(0, d.newPerDay - pulled), measured: true };
  }
  return { value: 0, measured: false };
}

/** One typical undercut in copper, from the gaps between the cheapest distinct price levels at most 1.2 times the claim. */
export function typicalUndercut(ladder: Array<Pick<Listing, 'unitPrice'>>, claim: number): number {
  const levels: number[] = [];
  for (const l of ladder) {
    if (l.unitPrice == null) continue;
    // A level far above the claim (a troll listing) says nothing about how sellers undercut (system review round 1).
    if (l.unitPrice > claim * UNDERCUT.maxLevelOverClaim) break;
    if (levels[levels.length - 1] !== l.unitPrice) levels.push(l.unitPrice);
    if (levels.length >= UNDERCUT.levels) break;
  }
  let gap: number;
  if (levels.length < 2) gap = claim * UNDERCUT.singleLevelShare;
  else {
    const gaps = levels.slice(1).map((p, i) => p - levels[i]!).sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    gap = gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
  }
  return Math.max(UNDERCUT.minCopper, Math.min(Math.round(gap), Math.floor(claim * UNDERCUT.maxShare)));
}

/**
 * The overnight queue (round 1 finding H4). Sale events over the night are Poisson, with a mean from the LOW sales
 * estimate (plan section 6: the inputs are cautious; round 6 finding 1, the middle let two repricing events read as a
 * 505g flip) less the new units others post ahead of Chip overnight (never under 0), and each event takes the mean
 * units per event. The middle estimate is only the card's "about N a day". Whoever is listed at or under Chip's price is served first, so the unit at queue position p (counting
 * every unit ahead of it) sells when the night brings at least ceil(p / units per event) events.
 * A vendor buys everything: every position sells.
 */
export interface Queue {
  /** chance the unit at queue position `pos` sells overnight; position 1 is the first unit with nothing ahead */
  at(pos: number): number;
  /** past this position the chance is under SELL_CHANCE.negligible; Infinity for a vendor */
  lastPos: number;
  /** mean sale events overnight, and the units each takes */
  meanEvents: number;
  unitsPerEvent: number;
}

export function overnightQueue(q: SellQuote, horizonHours: number): Queue {
  if (q.houseId == null) return { at: () => 1, lastPos: Infinity, meanEvents: Infinity, unitsPerEvent: 1 };
  // Hourly spread measured (sale counting's hourlyMean and hourlySd over at least 6 hours): units sold over the night
  // are normal with mean H x hourly mean and sd sqrt(H) x hourly sd, less the competing new posts, never under 0.
  // One hour's run of sales is not one event, so a deep steady market is not read as a coin toss (independent sale
  // counting test, finding 2). The Poisson event model is used otherwise. Either way the mean is the low estimate's
  // rate (never above the hourly mean), not the middle (round 6 finding 1).
  const lowPerHour = Math.max(0, q.salesPerDayLow ?? 0) / 24;
  if (q.hourlyMean != null && q.hourlySd != null && (q.hourlyHours ?? 0) >= SELL_CHANCE.normalMinHours) {
    const perHour = q.salesPerDayLow != null ? Math.min(q.hourlyMean, lowPerHour) : q.hourlyMean;
    const mean = Math.max(0, horizonHours * perHour - q.newPerHour * horizonHours);
    const sd = Math.sqrt(horizonHours) * Math.max(0, q.hourlySd);
    const at = (pos: number) => {
      if (pos <= 0) return 1;
      if (mean <= 0) return 0;
      if (sd <= 0) return pos <= mean ? 1 : 0;
      return 1 - normalCdf((pos - 0.5 - mean) / sd);
    };
    const lastPos = mean <= 0 ? 0 : Math.max(0, Math.floor(mean + sd * SELL_CHANCE.normalTailSd + 0.5));
    return { at, lastPos, meanEvents: mean, unitsPerEvent: 1 };
  }
  const upe = q.unitsPerEvent != null && q.unitsPerEvent > 0 ? q.unitsPerEvent : 1;
  const lowUnits = lowPerHour * horizonHours;
  const mu = Math.max(0, lowUnits - q.newPerHour * horizonHours) / upe;
  const maxJ = poissonUpper(mu, SELL_CHANCE.negligible);
  const tail = poissonTail(mu, maxJ);
  const lastPos = maxJ > 1 ? Math.floor(upe * (maxJ - 1) + 1e-9) : 0;
  return {
    at: (pos: number) => { if (pos <= 0) return 1; const j = Math.ceil(pos / upe - 1e-9); return j < tail.length ? tail[j]! : 0; },
    lastPos, meanEvents: mu, unitsPerEvent: upe,
  };
}

/** Standard normal cdf (Abramowitz and Stegun 7.1.26 on erf, error under 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export class SellBook {
  readonly ctx: DetectorContext;
  private memo = new Map<string, SellQuote | null>();

  constructor(private inputs: FlipInputs) {
    const items = new Map<number, ItemCtx>();
    for (const it of inputs.items.values()) items.set(it.id, { id: it.id, name: it.name, sellPrice: it.sellPrice, binding: it.binding, quality: it.quality });
    const vendors = new Map<number, VendorOffer[]>();
    for (const [id, vs] of inputs.vendors) vendors.set(id, vs.map(v => ({ npcId: v.npcId, npcName: v.npcName, faction: 'alliance', zone: v.zone, x: v.places[0]?.x ?? null, y: v.places[0]?.y ?? null,
      uiMap: v.places[0]?.uiMap ?? null, unitPrice: v.unitPrice, limited: v.limited, minStanding: v.minStanding })));
    const listings = new Map<number, Listing[]>();
    this.ctx = { houses: inputs.houses.map(h => this.houseCtx(h)), listings, items, vendors, demand: inputs.demand, now: inputs.now, drivers: inputs.drivers };
  }

  houseCtx(h: HouseRef): HouseCtx { return { id: h.id, name: h.name, faction: h.faction, cut: h.cut, pinned: true, publishedAt: h.publishedAt }; }

  demand(houseId: number, itemId: number): FlipDemand | undefined { return this.inputs.demand.get(houseId)?.get(itemId); }

  /**
   * The auction quote for an item on one house, from its current ladder (or `ladder` when a family must judge part of
   * it, as cheap listing does with the listings it does not buy). Null when the item is not listed there.
   */
  quote(h: HouseRef, itemId: number, ladder?: Listing[]): SellQuote | null {
    const key = `${h.id}:${itemId}`;
    if (!ladder && this.memo.has(key)) return this.memo.get(key)!;
    const ls = ladder ?? this.inputs.listings.get(h.id)?.get(itemId) ?? [];
    const q = ls.length ? this.build(h, itemId, ls) : null;
    if (!ladder) this.memo.set(key, q);
    return q;
  }

  private build(h: HouseRef, itemId: number, ls: Listing[]): SellQuote {
    const judged = judgeSell(this.ctx, this.houseCtx(h), itemId, ls);
    const d = this.demand(h.id, itemId);
    // A falling floor (FLOOR_DRIFT) lowers the claim by the drift over the horizon: by morning the floor Chip competes
    // with is that much lower (whole system review round 2, defect A: a slow undercutter, Hot Spices).
    const horizonH = this.inputs.settings.horizonHours;
    const driftDrop = d?.floorSlope != null && d.floorSlope < 0 ? Math.min(judged.price - 1, Math.round(-d.floorSlope * horizonH)) : 0;
    const claim = judged.price - Math.max(0, driftDrop);
    const undercut = typicalUndercut(ls, claim);
    const post = Math.max(1, claim - undercut);
    let ahead = 0;
    for (const l of ls) { if (l.unitPrice! > post) break; ahead += l.quantity; }
    // New posts at or under Chip's post price from the raw publishes when they are on disk (round 2 H2), else sale
    // counting's near the floor count.
    const np = this.inputs.newPosts?.get(h.id);
    // Measured at the post price before any drift: lowering the price for a falling floor must not hide the very
    // undercutters that make it fall (they keep posting under whatever the floor is).
    const postBefore = driftDrop > 0 ? Math.max(post, judged.price - typicalUndercut(ls, judged.price)) : post;
    // A listing above Chip's price sits behind him in the queue; the 5% margin only counts while the floor falls,
    // when those sellers will undercut again overnight (November 26 decision: 1.05 everywhere cut the list from 279 to 85,
    // dropping steady markets such as Mooncloth).
    const atPostOnly = np ? newPerDayAt(np, itemId, postBefore, driftDrop > 0 ? NEW_POSTS.competeShare : 1) : null;
    // While the floor falls, every post under the floor of its hour ends up under Chip: the larger count is used.
    const atPost = atPostOnly != null && driftDrop > 0 ? Math.max(atPostOnly, undercutPerDay(np, itemId) ?? 0) : atPostOnly;
    // Raw publishes under 6 hours (a pair whose raw file is gone): sale counting's near the floor count over its own
    // 6 hours or more is still a measurement; only when neither is there is competition unmeasured (and held back).
    const low = lowPerDay(d), fresh = atPost != null ? { value: atPost, measured: true } : newPerDay(d);
    const horizon = this.inputs.settings.horizonHours;
    const gates: string[] = [];
    // The same "sold near" rule judgeSell uses: at least one sale seen and a price it happened at.
    const recentOk = (d?.recentSales ?? 0) >= 3 && d?.recentSoldPrice != null;
    const soldRef = recentOk ? d!.recentSoldPrice! : judged.evidence.provenSales > 0 ? d?.soldPrice ?? null : null;
    const soldNear = judged.evidence.provenSales >= 1 && soldRef != null;
    if (judged.gates.length) gates.push(judged.gates[0]!);
    else if (!soldNear) gates.push('no sales seen yet near this price');
    else if (judged.score < FLIP_GATES.strengthShowAt) gates.push(`strength ${judged.score} of 100, under ${FLIP_GATES.strengthShowAt}`);
    const floor = ls[0]!.unitPrice!;
    // A price that just jumped: the listings sit above the proven price, and buyers paid up to the new level in the
    // last hour. Ranked on the proven price; the higher one is only noted.
    const sweep = d?.sweepHigh ?? null;
    const rising = sweep != null && floor > judged.price && sweep >= floor && !gates.length;
    const basis: SellQuote['basis'] = judged.picture.used;
    return {
      houseId: h.id, claimPrice: claim, netEach: netPerUnit(h.faction, post), undercutPrice: post, listed: floor, basis, ahead,
      salesPerDayLow: low.value, salesPerDayMid: d ? d.unitsPerDay : null, hoursWatched: hoursWatched(d), newPerHour: fresh.value / 24,
      sweepHigh: sweep, low3d: d?.low3d ?? this.inputs.low3d.get(h.id)?.get(itemId) ?? null, cv: d?.floorCv ?? null,
      strength: judged.score, strengthParts: judged.parts, gates, rising,
      provenSales: judged.evidence.provenSales, undercut, upTo: rising ? Math.min(sweep!, floor) : null,
      lowDerived: low.derived, newDerived: !fresh.measured, newOvernight: (fresh.value / 24) * horizon,
      saleEvents: d?.saleEvents ?? null, unitsPerEvent: d?.unitsPerEvent ?? null,
      lowCoverHours: this.inputs.low3dHours?.get(h.id)?.get(itemId) ?? hoursWatched(d),
      floorChange1h: d?.floorChange1h ?? null, newLastHour: d?.newLastHour ?? null,
      lowPending: low.pending ?? false,
      floorSlope: d?.floorSlope ?? null, floorFall: d?.floorFall ?? null, floorSpanHours: d?.floorSpanHours ?? null, driftDrop: Math.max(0, driftDrop),
      hourlyMean: d?.hourlyMean ?? null, hourlySd: d?.hourlySd ?? null, hourlyHours: d?.hourlyHours ?? (d?.hourlyMean != null ? hoursWatched(d) : null),
      note: [rising ? `buyers paid up to ${money(Math.min(sweep!, floor))} in the last hour; ranked at the proven ${money(claim)}` : judged.picture.note || null,
        driftDrop > 0 ? `the floor has been falling about ${money(Math.round(-d!.floorSlope!))} an hour, so the price used is ${money(driftDrop)} lower for the night` : null].filter(Boolean).join('; ') || null,
    };
  }

  /** Selling to any vendor: the item's vendor price, no cut, no limit, no competition. */
  vendorQuote(itemId: number): SellQuote | null {
    const p = this.inputs.items.get(itemId)?.sellPrice;
    if (!p || p <= 0) return null;
    return {
      houseId: null, claimPrice: p, netEach: p, undercutPrice: p, listed: null, basis: 'vendor', ahead: 0, salesPerDayLow: null, salesPerDayMid: null,
      hoursWatched: 0, newPerHour: 0, sweepHigh: null, low3d: p, cv: 0, strength: 100,
      strengthParts: [{ label: 'vendor price is fixed', points: 100, max: 100 }], gates: [], rising: false,
      provenSales: 0, undercut: 0, upTo: null, lowDerived: false, newDerived: false, newOvernight: 0, note: null,
    };
  }
}
