import type { Listing } from '../analysis/aggregate.ts';
import { judgeSell, type DetectorContext, type HouseCtx, type ItemCtx, type VendorOffer } from '../detectors/types.ts';
import { netPerUnit } from '../rules/fees.ts';
import { FLIP_GATES, LOW_ESTIMATE, NEW_POSTS_FALLBACK_SHARE, UNDERCUT } from '../rules/flips.ts';
import { money } from '../format/money.ts';
import type { FlipDemand, FlipInputs } from './inputs.ts';
import type { HouseRef, SellQuote } from './types.ts';

/**
 * The sell book: what the next unit nets when sold, on one of Chip's houses or to a vendor.
 * Auction prices go through judgeSell and src/rules/price.ts, so one troll listing never sets a price and the claim is
 * never above where real sales happened. Chip posts one typical undercut below the claim; the units he expects to
 * sell overnight come from a queue (capacity below).
 */

/** The cautious units sold a day: sale counting's lowPerDay, else a low estimate from the sales actually seen. */
export function lowPerDay(d: FlipDemand | undefined): { value: number | null; derived: boolean } {
  if (!d) return { value: null, derived: false };
  if (d.lowPerDay != null && Number.isFinite(d.lowPerDay)) return { value: Math.max(0, d.lowPerDay), derived: false };
  const hours = Math.max(d.hours, LOW_ESTIMATE.minHours);
  const seen = (d.unitsPerDay * hours) / 24;
  const low = Math.max(0, seen - LOW_ESTIMATE.z * Math.sqrt(seen));
  return { value: (low / hours) * 24, derived: true };
}

/** New units other sellers post under Chip a day: sale counting's newPerDay, else a cautious share of middle sales. */
export function newPerDay(d: FlipDemand | undefined): { value: number; derived: boolean } {
  if (d?.newPerDay != null && Number.isFinite(d.newPerDay)) return { value: Math.max(0, d.newPerDay), derived: false };
  return { value: (d?.unitsPerDay ?? 0) * NEW_POSTS_FALLBACK_SHARE, derived: true };
}

/** One typical undercut in copper, from the gaps between the cheapest distinct price levels. */
export function typicalUndercut(ladder: Array<Pick<Listing, 'unitPrice'>>, claim: number): number {
  const levels: number[] = [];
  for (const l of ladder) {
    if (l.unitPrice == null) continue;
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
 * Units Chip can expect to sell within the horizon at his post price: the low estimate of sales in that time, minus
 * units listed at or under his price, minus new units others post under him overnight, minus units his own higher
 * ranked flips already posted (shared pass). Never negative. A vendor buys without limit.
 */
export function capacity(q: SellQuote, horizonHours: number, used = 0): number {
  if (q.houseId == null) return Infinity;
  if (q.salesPerDayLow == null) return 0;
  return Math.max(0, (q.salesPerDayLow * horizonHours) / 24 - q.ahead - q.newPerHour * horizonHours - used);
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
    const claim = judged.price;
    const undercut = typicalUndercut(ls, claim);
    const post = Math.max(1, claim - undercut);
    let ahead = 0;
    for (const l of ls) { if (l.unitPrice! > post) break; ahead += l.quantity; }
    const low = lowPerDay(d), fresh = newPerDay(d);
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
    const rising = sweep != null && floor > claim && sweep >= floor && !gates.length;
    const basis: SellQuote['basis'] = judged.picture.used;
    return {
      houseId: h.id, claimPrice: claim, netEach: netPerUnit(h.faction, post), undercutPrice: post, listed: floor, basis, ahead,
      salesPerDayLow: low.value, salesPerDayMid: d ? d.unitsPerDay : null, hoursWatched: d?.hours ?? 0, newPerHour: fresh.value / 24,
      sweepHigh: sweep, low3d: d?.low3d ?? this.inputs.low3d.get(h.id)?.get(itemId) ?? null, cv: d?.floorCv ?? null,
      strength: judged.score, strengthParts: judged.parts, gates, rising,
      provenSales: judged.evidence.provenSales, undercut, upTo: rising ? Math.min(sweep!, floor) : null,
      lowDerived: low.derived, newDerived: fresh.derived, newOvernight: (fresh.value / 24) * this.inputs.settings.horizonHours,
      note: rising ? `buyers paid up to ${money(Math.min(sweep!, floor))} in the last hour; ranked at the proven ${money(claim)}` : judged.picture.note || null,
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
