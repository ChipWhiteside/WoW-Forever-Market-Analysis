/**
 * Turn one snapshot of listings into per item market stats, and difference it
 * against the previous snapshot of the same house and kind.
 *
 * Ledger rules applied here:
 *  - Equipment: buyout is the unit price (quantity is always 1, V13). Divided anyway, defensively.
 *  - Commodities: unit_price is already per unit (V4).
 *  - Bid only listings never set a floor.
 *  - Sell through comes from strict listing id set differences, never row counts (rule 4).
 *
 * How a vanished listing is judged (docs/flip-plan.md holes 11 and 12, verification B33 to B36):
 *  - Its age decides whether it could have run out of time. Forever listings last 2, 8 or 24 hours, and the
 *    time left a listing shows when first seen tells which (B33). A 2 hour listing first seen this hour cannot
 *    expire before the next publish, so if it vanished it was bought or cancelled, never expired.
 *  - Commodities fill cheapest first, and at one price newest first (B34). A stack that vanished while one ahead
 *    of it in that order survived was cancelled or expired. A stack ahead of a point buyers provably reached (a
 *    partly bought stack, or a vanished stack that could not have expired) was bought, unless it more likely ran out
 *    of time before a buyer at a random moment of the hour got to it.
 *  - One buyer is one sale event. On commodities a run of stacks taken from the front of the buy order in one hour
 *    counts as one event (cautious: it may have been several buyers). Equipment: each copy bought is one event.
 *  - A seller who cancels and posts the same quantity a little cheaper is undercutting, not selling. Matched on thin
 *    markets and on deep equipment markets (stricter terms there). Not on deep commodity markets, where the match
 *    is pure coincidence with restocking (B35) and buy order already catches cancels behind a survivor.
 */

export type TimeLeft = 'SHORT' | 'MEDIUM' | 'LONG' | 'VERY_LONG';

export interface Listing {
  id: number;
  itemId: number;
  quantity: number;
  /** copper per unit, null for bid only */
  unitPrice: number | null;
  timeLeft: TimeLeft;
}

export interface ItemStat {
  itemId: number;
  floor: number | null;
  unitsAtFloor: number;
  unitsWithin5: number;
  totalUnits: number;
  listings: number;
  /** cheapest price points, [unitPrice, units] */
  ladder: Array<[number, number]>;
  goneListings: number | null;
  goneUnits: number | null;
  /** units of vanished listings that could have run out of time (from their age) and were not judged bought */
  goneUnitsExpiring: number | null;
  goneUnitsNearFloor: number | null;
  /** of goneUnitsNearFloor, ones judged NOT sold (expired, cancelled, cancelled to undercut, or priced over a
   * cheaper survivor). goneUnitsNearFloor minus this is near floor sales under the current rules. */
  goneUnitsExpiringNearFloor: number | null;
  /** copper value of every unit judged sold (soldUnits), so demand carries the price it happened at */
  soldValue: number | null;
  newUnits: number | null;
  /** units judged sold since the last publish, current rules, sweeps past the floor included */
  soldUnits: number | null;
  /** sale events behind soldUnits. Commodities: each unbroken run of stacks judged bought, in buy order, is one event
   * (one buyer sweeping 116 stacks is one sale, so this is a cautious count of buyers). Equipment: each copy bought. */
  soldEvents: number | null;
  /** highest unit price judged bought since the last publish, null when nothing was bought */
  sweepHigh: number | null;
  /** new units other sellers posted at or under 1.1 times the floor: the higher of the previous and the current floor, so
   * posts at a floor a sweep just raised count, and one cheap new post cannot shrink the line */
  newNearFloor: number | null;
  /** stack growth check: units judged sold beyond previous units + new units - current units. That total equals the
   * units that left the house whenever no stack grows, so this is not an independent bound on sales; it is non zero
   * only if a listing's quantity went up (never seen: 0 of 3,373 changed stacks grew, B34). Logged as a suspected bug. */
  boundBreach: number | null;
}

export const LADDER_POINTS = 12;

const H = 3600_000;

/** Forever listing lengths in hours (B15: Chip's own listings). */
export const LISTING_HOURS = [2, 8, 24] as const;

/**
 * The listing length a time_left reading means when the listing is under 1.6 hours old (B33, measured on 259,823
 * new listings on 8 houses: none showed SHORT, every fresh MEDIUM was gone 7 hours later, every fresh LONG was SHORT,
 * MEDIUM or gone 7 hours later, every fresh VERY_LONG still up 7 or 8 hours later was still VERY_LONG).
 */
export const FRESH_HOURS: Partial<Record<TimeLeft, number>> = { MEDIUM: 2, LONG: 8, VERY_LONG: 24 };

/**
 * Hours left each bucket can mean (B33). SHORT under 30 minutes and MEDIUM 30 minutes to 2 hours. LONG ends between
 * 11 and 15 hours: 4,293 listings read LONG 9 hours apart (so LONG reaches past 11 hours), and fresh 24 hour
 * listings with 15 to 16 hours left still read VERY_LONG. The usual 12 fits; the ranges below allow the whole
 * measured span. Only the lower end of each matters for "could it expire within the hour".
 */
export const BUCKET_HOURS: Record<TimeLeft, readonly [number, number]> = {
  SHORT: [0, 0.5], MEDIUM: [0.5, 2], LONG: [2, 15], VERY_LONG: [11, 24],
};

/** A vanished listing whose chance of having run out of time exceeds this is treated as possibly expired. */
export const EXPIRY_CHANCE = 0.05;
/** Equipment buyers pick a listing: one priced over 1.25 times a cheaper copy that is still up was not bought. */
export const EQUIP_SURVIVOR_MARGIN = 1.25;
/** Equipment sales count only up to 1.25 times the previous floor: a pricey copy vanishing is too often a cancel or a
 * troll (B18). It was 1.1; buyers also take a copy a little over the cheapest (a better suffix), and the simulator
 * read 1.25 as the better line (B36). */
export const EQUIP_SOLD_BAND = 1.25;
/** A market with this many listings or fewer last hour is thin: cancel and relist matching is looser there. */
export const THIN_LISTINGS = 5;

/**
 * Commodity buy order: the buy window takes the cheapest listing first and, at one price, the newest listing (highest
 * id) first. Measured on 3,373 partly bought stacks (B34): every cheaper listing was gone, and at the same price
 * 9,112 newer listings were gone against 1 still up, while older ones stayed up about 90 percent of the time.
 */
export function buysFirst(a: Listing, b: Listing): boolean {
  return a.unitPrice! < b.unitPrice! || (a.unitPrice === b.unitPrice && a.id > b.id);
}

/** First sight of a listing, as kept in table listing_seen. */
export interface Seen {
  firstSeen: number;
  firstTimeLeft: TimeLeft;
  /** the publish before first sight, when it was differenced (gap of 1.6 hours or less): the listing was posted
   * after it. null when the listing was already up when tracking started, or first seen after a gap. */
  postedAfter: number | null;
}

/** Chip's own trades, so they never count as market demand or competing posts. No data source feeds this yet. */
export interface OwnTrades { listingIds: Set<number> }

export interface AggregateOpts {
  /** stackables fill cheapest first through a buy window; equipment buyers pick a listing */
  commodity?: boolean;
  /** publish times of the previous and current snapshot, ms. Default one hour apart. */
  prevAt?: number;
  curAt?: number;
  /** first sight of the previous snapshot's listings. Missing entries are listings of unknown age. */
  seen?: Map<number, Seen>;
  own?: OwnTrades;
  /** filled in when given: bucket readings that disagree with a listing's age, and stack growth check failures */
  diag?: Diagnostics;
}

export interface Diagnostics {
  ageConflicts: number;
  breaches: string[];
  /** when given, the verdict on every listing that lost units: sold, expired, cancelled, undercut, above, own */
  verdicts?: Map<number, string>;
}

export function fromAuctionRows(rows: Array<{ id: number; item: { id: number }; buyout?: number; quantity: number; time_left: TimeLeft }>): Listing[] {
  return rows.map(r => ({
    id: r.id,
    itemId: r.item.id,
    quantity: r.quantity,
    unitPrice: r.buyout != null && r.buyout > 0 ? Math.floor(r.buyout / r.quantity) : null,
    timeLeft: r.time_left,
  }));
}

export function fromCommodityRows(rows: Array<{ id: number; item: { id: number }; unit_price: number; quantity: number; time_left: TimeLeft }>): Listing[] {
  return rows.map(r => ({ id: r.id, itemId: r.item.id, quantity: r.quantity, unitPrice: r.unit_price, timeLeft: r.time_left }));
}

/** Listing length in hours, when it can be known: from a fresh first reading, or VERY_LONG at any age (only 24 hour listings show it). */
export function listingHours(s: Seen | undefined): number | null {
  if (!s) return null;
  if (s.postedAfter != null && s.firstSeen - s.postedAfter <= 1.6 * H) return FRESH_HOURS[s.firstTimeLeft] ?? null;
  return s.firstTimeLeft === 'VERY_LONG' ? 24 : null;
}

/**
 * Chance that a listing seen at `prevAt` had run out of time by `curAt`, if nobody bought it. Works out the window
 * its expiry must fall in from every reading of it (its time left now, its time left and age when first seen) and
 * returns the share of that window before `curAt`. `conflict` is true when the readings disagree (a suspected bug
 * in the bucket mapping); the time left at `prevAt` alone is used then.
 */
export function expiryChance(l: Listing, seen: Seen | undefined, prevAt: number, curAt: number): { chance: number; conflict: boolean; beforeBuy: number } {
  // Publish stamps can lag the data by minutes (Last-Modified is when the file was written, not when the house was
  // read), and a bucket edge read near the boundary can be off by a few minutes. Nine minutes covers both.
  const slack = 0.15 * H;
  const b = BUCKET_HOURS[l.timeLeft];
  const own: [number, number] = [prevAt + b[0] * H - slack, prevAt + b[1] * H + slack];
  let [lo, hi] = own;
  if (seen) {
    const fb = BUCKET_HOURS[seen.firstTimeLeft];
    lo = Math.max(lo, seen.firstSeen + fb[0] * H - slack);
    hi = Math.min(hi, seen.firstSeen + fb[1] * H + slack);
    const d = listingHours(seen);
    if (d != null && seen.postedAfter != null && seen.firstSeen - seen.postedAfter <= 1.6 * H) {
      lo = Math.max(lo, seen.postedAfter + d * H);
      hi = Math.min(hi, seen.firstSeen + d * H);
    }
  }
  let conflict = false;
  if (hi < lo) { conflict = true; [lo, hi] = own; }
  // Chance it ran out before a buyer who came at a random moment of the hour: expiry and the buy both uniform.
  const ranOutBy = (t: number) => t <= lo ? 0 : t >= hi || hi === lo ? 1 : (t - lo) / (hi - lo);
  let beforeBuy = 0;
  for (let i = 0; i < 12; i++) beforeBuy += ranOutBy(prevAt + ((i + 0.5) / 12) * (curAt - prevAt)) / 12;
  return { chance: ranOutBy(curAt), conflict, beforeBuy };
}

/**
 * First sight of every current listing: kept from `seen` when already known, otherwise this publish. A listing
 * that was in the previous snapshot but is unknown to `seen` (first run after an update) gets the previous
 * publish as its first sight and an unknown age.
 */
export function nextSeen(seen: Map<number, Seen> | null, current: Listing[], curAt: number,
  previous: { listings: Listing[]; at: number } | null, differenced: boolean): Map<number, Seen> {
  const out = new Map<number, Seen>();
  const prevById = previous ? new Map(previous.listings.map(l => [l.id, l])) : null;
  // One shared object per kind of first sight: hundreds of thousands of listings, only a handful of distinct values.
  const shared = new Map<string, Seen>();
  const make = (firstSeen: number, firstTimeLeft: TimeLeft, postedAfter: number | null): Seen => {
    const key = `${firstSeen}:${firstTimeLeft}:${postedAfter}`;
    let s = shared.get(key);
    if (!s) shared.set(key, (s = { firstSeen, firstTimeLeft, postedAfter }));
    return s;
  };
  for (const l of current) {
    const known = seen?.get(l.id);
    if (known) { out.set(l.id, known); continue; }
    const before = prevById?.get(l.id);
    if (before) out.set(l.id, make(previous!.at, before.timeLeft, null));
    else out.set(l.id, make(curAt, l.timeLeft, differenced && previous ? previous.at : null));
  }
  return out;
}

type Verdict = 'sold' | 'expired' | 'cancelled' | 'undercut' | 'above' | 'own';

interface Lost { l: Listing; lost: number; vanished: boolean; verdict: Verdict; expiring: boolean; beforeBuy: number }

/** Fresh posts of one quantity and length, cheapest first. `next[i]` points at the nearest unused post at or before i. */
interface Pool { ls: Listing[]; next: number[] }

/** Index of the dearest unused post priced at or under `price`, or -1. Union find with path halving over used posts. */
function takeAtOrBelow(pool: Pool, price: number): number {
  let lo = 0, hi = pool.ls.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (pool.ls[mid]!.unitPrice! <= price) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  while (i >= 0 && pool.next[i] !== i) { const j = pool.next[i]!; pool.next[i] = j < 0 ? j : pool.next[j]!; i = j; }
  return i;
}

/**
 * `commodity`: stackables are bought through a window that always fills from the cheapest listing first.
 * Equipment buyers pick a listing, so there a 25 percent margin applies.
 */
export function aggregate(current: Listing[], previous: Listing[] | null, opts: AggregateOpts = {}): ItemStat[] {
  const commodity = !!opts.commodity;
  const curAt = opts.curAt ?? (opts.prevAt != null ? opts.prevAt + H : H);
  const prevAt = opts.prevAt ?? curAt - H;
  const own = opts.own?.listingIds;
  const byItem = new Map<number, Listing[]>();
  for (const l of current) {
    let arr = byItem.get(l.itemId);
    if (!arr) byItem.set(l.itemId, (arr = []));
    arr.push(l);
  }
  const curById = new Map(current.map(l => [l.id, l]));
  const prevById = previous ? new Map(previous.map(l => [l.id, l])) : null;
  const prevByItem = new Map<number, Listing[]>();
  if (previous) for (const l of previous) {
    let arr = prevByItem.get(l.itemId);
    if (!arr) prevByItem.set(l.itemId, (arr = []));
    arr.push(l);
  }

  const out: ItemStat[] = [];
  const itemIds = new Set<number>([...byItem.keys(), ...prevByItem.keys()]);
  for (const itemId of itemIds) {
    const ls = byItem.get(itemId) ?? [];
    let floor: number | null = null;
    let totalUnits = 0;
    const points = new Map<number, number>();
    for (const l of ls) {
      totalUnits += l.quantity;
      if (l.unitPrice == null) continue;
      if (floor == null || l.unitPrice < floor) floor = l.unitPrice;
      points.set(l.unitPrice, (points.get(l.unitPrice) ?? 0) + l.quantity);
    }
    const ladder = [...points.entries()].sort((a, b) => a[0] - b[0]);
    let unitsWithin5 = 0;
    if (floor != null) for (const [p, u] of ladder) if (p <= floor * 1.05) unitsWithin5 += u;
    const base = { itemId, floor, unitsAtFloor: floor == null ? 0 : points.get(floor) ?? 0, unitsWithin5, totalUnits, listings: ls.length, ladder: ladder.slice(0, LADDER_POINTS) };
    if (!prevById) {
      // A listing-less item can only come from the previous snapshot, so without one every item here has listings.
      out.push({ ...base, goneListings: null, goneUnits: null, goneUnitsExpiring: null, goneUnitsNearFloor: null, goneUnitsExpiringNearFloor: null,
        soldValue: null, newUnits: null, soldUnits: null, soldEvents: null, sweepHigh: null, newNearFloor: null, boundBreach: null });
      continue;
    }
    out.push({ ...base, ...difference(itemId, prevByItem.get(itemId) ?? [], ls, floor) });
  }
  return out;

  function difference(itemId: number, prevL: Listing[], curL: Listing[], curFloor: number | null) {
    let prevFloor: number | null = null;
    for (const l of prevL) if (l.unitPrice != null && (prevFloor == null || l.unitPrice < prevFloor)) prevFloor = l.unitPrice;
    // The first previous listing still up now (whole or partly bought), in buy order. Commodities: the buy window
    // takes the cheapest first and, at one price, the newest first (B34), so nothing after it in that order was
    // bought. Equipment: the cheapest copy still up.
    let survivor: Listing | null = null;
    for (const l of prevL) if (l.unitPrice != null && curById.has(l.id) && (!survivor || (commodity ? buysFirst(l, survivor) : l.unitPrice < survivor.unitPrice!))) survivor = l;

    const lostList: Lost[] = [];
    for (const l of prevL) {
      const still = curById.get(l.id) ?? null;
      const lost = still ? Math.max(0, l.quantity - still.quantity) : l.quantity;
      if (lost === 0) continue;
      const e: Lost = { l, lost, vanished: !still, verdict: 'sold', expiring: false, beforeBuy: 0 };
      lostList.push(e);
      if (own?.has(l.id)) { e.verdict = 'own'; continue; }
      if (!still) {
        const ex = expiryChance(l, opts.seen?.get(l.id), prevAt, curAt);
        e.expiring = ex.chance > EXPIRY_CHANCE;
        e.beforeBuy = ex.beforeBuy;
        if (ex.conflict && opts.diag) opts.diag.ageConflicts++;
        if (l.unitPrice == null) e.verdict = 'cancelled';
        else if (survivor && (commodity ? buysFirst(survivor, l) : l.unitPrice > survivor.unitPrice! * EQUIP_SURVIVOR_MARGIN)) e.verdict = 'above';
        else if (e.expiring) e.verdict = 'expired';
      }
    }

    // Commodities: the furthest point in buy order buyers provably reached. First a stack that was partly bought
    // (only buyers shrink a stack); every listing before it in buy order was consumed.
    let reached: Listing | null = null;
    const reach = (l: Listing) => { if (!reached || buysFirst(reached, l)) reached = l; };
    if (commodity) for (const e of lostList) if (!e.vanished && e.verdict === 'sold') reach(e.l);

    // Cancel to undercut: a vanished listing replaced by a new one of the same quantity at a lower or similar price.
    const fresh = curL.filter(n => !prevById!.has(n.id) && n.unitPrice != null && !own?.has(n.id));
    // Not on deep commodity markets: there a same quantity, cheaper post shows up for 31 percent of stacks that were
    // certainly bought and 27 percent of undecided ones (B35), so a match says nothing and would erase real sales.
    // Buy order already rules out cancels of every stack behind a survivor there.
    const thin = prevL.length <= THIN_LISTINGS;
    const matchable = thin || !commodity;
    const candidates = lostList.filter(e => matchable && e.vanished && e.verdict === 'sold' && (!commodity || !reached || buysFirst(reached, e.l)))
      .sort((a, b) => b.l.unitPrice! - a.l.unitPrice! || b.l.id - a.l.id);
    if (candidates.length && fresh.length) {
      if (thin) {
        // Thin market: a handful of listings, so a plain scan. Same quantity, within 25 percent either way.
        const used = new Set<number>();
        for (const e of candidates) {
          const old = e.l.unitPrice!;
          let best: Listing | null = null;
          for (const n of fresh) {
            if (used.has(n.id) || n.quantity !== e.l.quantity || Math.abs(n.unitPrice! - old) > old * 0.25) continue;
            const dn = Math.abs(n.unitPrice! - old), db = best ? Math.abs(best.unitPrice! - old) : Infinity;
            // Closest price first; then the cheaper post; then the newest. Same answer whatever order the posts came in.
            if (!best || dn < db || (dn === db && (n.unitPrice! < best.unitPrice! || (n.unitPrice === best.unitPrice && n.id > best.id)))) best = n;
          }
          if (best) { used.add(best.id); e.verdict = 'undercut'; }
        }
      } else {
        // Deep equipment market: an undercut (same or lower, at most 20 percent lower), the same listing length when
        // known, and what provoked it: a cheaper copy that was already up last hour. Fresh posts are bucketed by
        // quantity and length and sorted by price, so each candidate finds the closest post at or under its price
        // in log time (a plain scan took minutes on a 200,000 listing snapshot).
        let cheapestSurvivor = Infinity;
        for (const o of curL) if (o.unitPrice != null && prevById!.has(o.id) && o.unitPrice < cheapestSurvivor) cheapestSurvivor = o.unitPrice;
        const pools = new Map<string, Pool>();
        for (const n of fresh) {
          const key = `${n.quantity}:${FRESH_HOURS[n.timeLeft] ?? '?'}`;
          let pool = pools.get(key);
          if (!pool) pools.set(key, (pool = { ls: [], next: [] }));
          pool.ls.push(n);
        }
        for (const pool of pools.values()) {
          pool.ls.sort((a, b) => a.unitPrice! - b.unitPrice! || a.id - b.id);
          pool.next = pool.ls.map((_, i) => i);
        }
        for (const e of candidates) {
          const old = e.l.unitPrice!;
          if (!(cheapestSurvivor < old)) continue;
          const dOld = listingHours(opts.seen?.get(e.l.id));
          let best: { pool: Pool; i: number } | null = null;
          for (const [key, pool] of pools) {
            const [q, d] = key.split(':');
            if (Number(q) !== e.l.quantity) continue;
            if (dOld != null && d !== '?' && Number(d) !== dOld) continue;
            const i = takeAtOrBelow(pool, old);
            if (i < 0 || pool.ls[i]!.unitPrice! < old * 0.8) continue;
            const p = pool.ls[i]!.unitPrice!;
            if (!best || p > best.pool.ls[best.i]!.unitPrice! || (p === best.pool.ls[best.i]!.unitPrice! && pool.ls[i]!.id > best.pool.ls[best.i]!.id)) best = { pool, i };
          }
          if (best) { best.pool.next[best.i] = best.i - 1; e.verdict = 'undercut'; }
        }
      }
    }

    if (commodity) {
      // Vanished stacks that could not have expired and were not reposted were bought: buyers reached them.
      for (const e of lostList) if (e.vanished && e.verdict === 'sold') reach(e.l);
      // Anything before that point in buy order was consumed by the buy window when the buyer got there, unless it
      // had already run out of time: a stack more likely to have expired before a buyer at a random moment of the
      // hour than after stays expired.
      const r = reached as Listing | null;
      for (const e of lostList) if (r && buysFirst(e.l, r) && (e.verdict === 'undercut' || (e.verdict === 'expired' && e.beforeBuy < 0.5))) e.verdict = 'sold';
    } else {
      for (const e of lostList) if (e.verdict === 'sold' && (prevFloor == null || e.l.unitPrice! > prevFloor * EQUIP_SOLD_BAND)) e.verdict = 'above';
    }

    if (opts.diag?.verdicts) for (const e of lostList) opts.diag.verdicts.set(e.l.id, e.verdict);
    let goneListings = 0, goneUnits = 0, expiring = 0, nearFloor = 0, notSoldNear = 0, soldUnits = 0, soldValue = 0, soldEvents = 0;
    let sweepHigh: number | null = null;
    if (commodity) {
      // One event per unbroken run of bought stacks in buy order. Only a stack still up whole ends a run: a stack that
      // left unbought (ran out, pulled) was simply gone when the buyer came, so one buyer can have taken both sides.
      const verdict = new Map(lostList.map(e => [e.l.id, e.verdict]));
      const order = prevL.filter(l => l.unitPrice != null).sort((a, b) => buysFirst(a, b) ? -1 : buysFirst(b, a) ? 1 : 0);
      let inRun = false;
      for (const l of order) {
        const v = verdict.get(l.id);
        if (v === 'sold') { if (!inRun) soldEvents++; inRun = true; }
        else if (v == null) inRun = false;
      }
    }
    for (const e of lostList) {
      if (e.vanished) goneListings++;
      goneUnits += e.lost;
      const sold = e.verdict === 'sold';
      if (e.vanished && e.expiring && !sold) expiring += e.lost;
      const near = prevFloor != null && e.l.unitPrice != null && e.l.unitPrice <= prevFloor * 1.1;
      if (near) { nearFloor += e.lost; if (!sold) notSoldNear += e.lost; }
      if (sold) {
        soldUnits += e.lost;
        if (!commodity) soldEvents++;
        soldValue += e.lost * e.l.unitPrice!;
        if (sweepHigh == null || e.l.unitPrice! > sweepHigh) sweepHigh = e.l.unitPrice!;
      }
    }
    let newUnits = 0, newNearFloor = 0;
    const ref = prevFloor == null ? curFloor : curFloor == null ? prevFloor : Math.max(prevFloor, curFloor);
    let curUnits = 0;
    for (const l of curL) {
      curUnits += l.quantity;
      if (prevById!.has(l.id)) continue;
      newUnits += l.quantity;
      if (!own?.has(l.id) && ref != null && l.unitPrice != null && l.unitPrice <= ref * 1.1) newNearFloor += l.quantity;
    }
    // Stack growth check: from totals, units that left the house. This equals the units lost per listing unless a
    // stack grew, so a breach means a listing's quantity went up (a suspected bug or a game change), nothing more.
    const prevUnits = prevL.reduce((s, l) => s + l.quantity, 0);
    const bound = Math.max(0, prevUnits + newUnits - curUnits);
    let boundBreach = 0;
    if (soldUnits > bound) {
      boundBreach = soldUnits - bound;
      opts.diag?.breaches.push(`item ${itemId}: ${soldUnits} judged sold, only ${bound} left the house (a stack grew)`);
      soldValue = Math.round(soldValue * (bound / soldUnits));
      soldUnits = bound;
      soldEvents = Math.min(soldEvents, bound);
    }
    return { goneListings, goneUnits, goneUnitsExpiring: expiring, goneUnitsNearFloor: nearFloor, goneUnitsExpiringNearFloor: notSoldNear,
      soldValue, newUnits, soldUnits, soldEvents, sweepHigh, newNearFloor, boundBreach };
  }
}
