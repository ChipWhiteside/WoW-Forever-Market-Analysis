/**
 * A small auction house simulator with known ground truth, for the sale counter only (docs/flip-plan.md section 9).
 *
 * Minute by minute it plays sellers posting 2, 8 and 24 hour listings, buyers, big sweeps, cancels to undercut,
 * plain pulls of any listing (the cheapest included), the cheapest seller pulling to post again, mass pulls (the
 * Salmon pattern, B37), price wars, bid only listings won at expiry, expiries and expired listings posted again,
 * then takes an hourly snapshot like Blizzard's: taken a few minutes off the hour and stamped 0 to 5 minutes late
 * (Last-Modified lag), with time left buckets read a few minutes either side of their edges.
 * Commodity buyers fill cheapest first, newest first at one price, through a buy window, and partial buys shrink a
 * stack. Equipment buyers pick a copy: mostly the cheapest, some a dearer one (a better suffix), some anything they
 * can afford, and now and then one buyer sweeps every copy under a price.
 * Truth per hour and item: units bought from listings that were up at the previous snapshot (what a snapshot
 * counter can see), units bought from listings posted and bought inside the hour (invisible by design), and buyers
 * (one buyer is one sale event).
 *
 * Pull rates default to what the real snapshots show behind the cheapest listing (B38), applied to every listing.
 */
import type { Listing, TimeLeft } from '../../src/analysis/aggregate.ts';

export type MarketType = 'deep' | 'thin' | 'equipment';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Share of listings sellers pull each hour, measured on the real snapshots where no buyer can reach (B38): deep
 * commodity listings behind a stack still up in buy order 2.2%, thin commodity ones 2.6%, equipment priced over
 * 2 times the floor 3.5% (an upper bound: a few of those are bought for a better suffix).
 */
export const MEASURED_CANCELS: Record<MarketType, number> = { deep: 0.022, thin: 0.026, equipment: 0.035 };

interface Spec {
  commodity: boolean;
  ref: [number, number];
  postsPerHour: number;
  postQty: (r: () => number) => number;
  buyersPerHour: number;
  buyQty: (r: () => number) => number;
  sweepsPerHour: number;
  undercutsPerHour: number;
  cancelPerListingHour: number;
  relistShare: number;
  /** the cheapest seller pulls and posts again (to refresh the length, or a little lower), per item per hour */
  refreshPerHour: number;
  /** a seller pulls most stacks at one price and posts part of them again in other sizes, per item per hour */
  massPullsPerHour: number;
  /** a seller floods the market well under the floor, per item per hour */
  warsPerHour: number;
  /** share of new posts with no buyout (equipment only), and the chance a bid wins one at expiry */
  bidOnlyShare: number;
  bidWinShare: number;
}

const pickWeighted = <T,>(r: () => number, items: Array<[T, number]>): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of items) { x -= w; if (x <= 0) return v; }
  return items[items.length - 1]![0];
};

/** Listing lengths as measured on Forever's new listings (B33): 17% 2 hour, 64% 8 hour, 18% 24 hour. */
const duration = (r: () => number) => pickWeighted(r, [[120, 17], [480, 64], [1440, 18]]);

export const SPECS: Record<MarketType, Spec> = {
  // Copper Ore like, sized to house 111's commodity markets of 50 to 500 listings (about 150 listings, 33 new posts
  // and 21 listings bought an hour): stacks of 1 to 20, many buyers, a sweep every day or so.
  deep: {
    commodity: true, ref: [80, 400], postsPerHour: 30,
    postQty: r => pickWeighted(r, [[1, 30], [2, 10], [3, 8], [5, 10], [10, 12], [20, 25], [1 + Math.floor(r() * 19), 5]]),
    buyersPerHour: 14, buyQty: r => 1 + Math.floor(-Math.log(1 - r()) * 10),
    sweepsPerHour: 0.04, undercutsPerHour: 1, cancelPerListingHour: MEASURED_CANCELS.deep, relistShare: 0.4,
    refreshPerHour: 0.3, massPullsPerHour: 0.03, warsPerHour: 0.01, bidOnlyShare: 0, bidWinShare: 0,
  },
  // A dye or a rare reagent: a handful of listings (house 111 thin markets: about 3 up, a sale every 3 hours).
  thin: {
    commodity: true, ref: [500, 5000], postsPerHour: 0.5,
    postQty: r => pickWeighted(r, [[1, 50], [2, 20], [5, 20], [10, 10]]),
    buyersPerHour: 0.35, buyQty: r => pickWeighted(r, [[1, 60], [2, 20], [5, 20]]),
    sweepsPerHour: 0.01, undercutsPerHour: 0.08, cancelPerListingHour: MEASURED_CANCELS.thin, relistShare: 0.5,
    refreshPerHour: 0.03, massPullsPerHour: 0.005, warsPerHour: 0.005, bidOnlyShare: 0, bidWinShare: 0,
  },
  // A green with a few dozen copies up (house 111 equipment markets of 10 to 60 copies: about 24 up, 4 new posts and
  // 1 bought an hour): quantity 1, buyers pick one, and a disenchanter now and then buys every copy under a price.
  equipment: {
    commodity: false, ref: [2000, 50000], postsPerHour: 3,
    postQty: () => 1,
    buyersPerHour: 1.2, buyQty: () => 1,
    sweepsPerHour: 0.02, undercutsPerHour: 0.15, cancelPerListingHour: MEASURED_CANCELS.equipment, relistShare: 0.4,
    refreshPerHour: 0.05, massPullsPerHour: 0.01, warsPerHour: 0.005, bidOnlyShare: 0.05, bidWinShare: 0.3,
  },
};

interface Live { id: number; item: number; qty: number; price: number | null; posted: number; ends: number; dur: number }

export interface SimOpts {
  type: MarketType; seed: number; items?: number; hours?: number; warmupHours?: number; longEndsAt?: number;
  /** override how often a seller cancels to undercut, per item per hour (sensitivity runs) */
  undercutsPerHour?: number;
  /** override the share of listings a seller pulls each hour without posting again (sensitivity runs) */
  cancelPerListingHour?: number;
  /** turn off the timing and bucket edge jitter (to check the counter is not leaning on it) */
  exactClock?: boolean;
}

export interface SimRun {
  type: MarketType;
  commodity: boolean;
  /** hourly snapshots, `at` in ms as the publish would be stamped */
  snapshots: Array<{ at: number; listings: Listing[] }>;
  /** truth[k] for the hour ending at snapshot k (k >= 1): item -> units */
  visible: Array<Map<number, number>>;
  invisible: Array<Map<number, number>>;
  /** buyers who took units from listings up at the previous snapshot: item -> count (one buyer, one sale event) */
  buyers: Array<Map<number, number>>;
  /** what really ended each listing that vanished */
  fate: Map<number, 'bought' | 'expired' | 'undercut' | 'cancelled' | 'won'>;
}

/** Bucket for minutes left. `longEndsAt` is where LONG gives way to VERY_LONG: measured between 11 and 15 hours on Forever (B33), 12 by default. `jitter` moves every edge by that many minutes. */
export function bucket(minutesLeft: number, longEndsAt = 720, jitter = 0): TimeLeft {
  if (minutesLeft < 30 + jitter) return 'SHORT';
  if (minutesLeft < 120 + jitter) return 'MEDIUM';
  if (minutesLeft < longEndsAt + jitter) return 'LONG';
  return 'VERY_LONG';
}

export function simulate(o: SimOpts): SimRun {
  const spec = { ...SPECS[o.type], ...(o.undercutsPerHour != null ? { undercutsPerHour: o.undercutsPerHour } : {}),
    ...(o.cancelPerListingHour != null ? { cancelPerListingHour: o.cancelPerListingHour } : {}) };
  const r = rng(o.seed);
  const nItems = o.items ?? 6;
  const hours = o.hours ?? 24 * 7;
  const warm = (o.warmupHours ?? 36) * 60;
  const refs = new Map<number, number>();
  for (let i = 0; i < nItems; i++) refs.set(1000 + i, Math.round(spec.ref[0] + r() * (spec.ref[1] - spec.ref[0])));
  const live = new Map<number, Live[]>();
  for (const id of refs.keys()) live.set(id, []);
  let nextId = 1;
  const fate: SimRun['fate'] = new Map();
  const pending: Array<{ at: number; item: number; qty: number; dur: number }> = [];
  const snapshots: SimRun['snapshots'] = [];
  const visible: SimRun['visible'] = [];
  const invisible: SimRun['invisible'] = [];
  const buyers: SimRun['buyers'] = [];
  let lastSnap = -Infinity;
  const poisson = (lambda: number) => { let k = 0, p = Math.exp(-lambda), s = p; const u = r(); while (u > s && k < 50) { k++; p *= lambda / k; s += p; } return k; };
  const floorOf = (ls: Live[]) => ls.reduce((m, l) => l.price == null ? m : Math.min(m, l.price), Infinity);
  const bidOnly = (l: Live) => l.price == null;

  const post = (t: number, item: number, qty: number, dur: number, at?: number) => {
    const ls = live.get(item)!;
    const ref = refs.get(item)!;
    let price: number | null;
    if (at != null) price = at;
    else if (spec.bidOnlyShare > 0 && r() < spec.bidOnlyShare) price = null;
    else {
      const floor = floorOf(ls);
      const reserve = ref * (0.8 + r() * 0.2);
      if (r() < 0.2) price = ref * (1.1 + r() * 0.7); // a lazy seller far up the ladder
      else if (floor !== Infinity && floor >= reserve) price = floor - Math.max(1, floor * r() * 0.02);
      else price = reserve * (1 + r() * 0.25);
    }
    ls.push({ id: nextId++, item, qty, price: price == null ? null : Math.max(1, Math.round(price)), posted: t, ends: t + dur, dur });
  };
  // Trades of the hour now running; handed over at the snapshot that closes it.
  let hourVisible = new Map<number, number>(), hourInvisible = new Map<number, number>(), hourBuyers = new Map<number, number>();
  const add = (m: Map<number, number>, k: number, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const record = (l: Live, units: number) => add(l.posted < lastSnap ? hourVisible : hourInvisible, l.item, units); // posted before the last snapshot: it was in it
  const buy = (item: number, want: number, maxPrice: number) => {
    const ls = live.get(item)!;
    let seen = false;
    const take = (l: Live, units: number) => { record(l, units); if (l.posted < lastSnap) seen = true; };
    if (spec.commodity) {
      ls.sort((a, b) => a.price! - b.price! || b.id - a.id); // cheapest first, newest first at one price (B34)
      while (want > 0 && ls.length && ls[0]!.price! <= maxPrice) {
        const l = ls[0]!;
        const n = Math.min(want, l.qty);
        l.qty -= n; want -= n;
        take(l, n);
        if (l.qty === 0) { ls.shift(); fate.set(l.id, 'bought'); }
      }
    } else {
      for (let k = 0; k < want; k++) {
        const ok = ls.filter(l => !bidOnly(l) && l.price! <= maxPrice).sort((a, b) => a.price! - b.price!);
        if (!ok.length) break;
        // Most buyers take the cheapest; some pick a copy within 20 percent of it (a better suffix); some take any
        // copy they can afford (a suffix they want, whatever the price).
        const near = ok.filter(l => l.price! <= ok[0]!.price! * 1.2);
        const u = r();
        const pick = u < 0.65 ? ok[0]! : u < 0.85 ? near[Math.floor(r() * near.length)]! : ok[Math.floor(r() * ok.length)]!;
        ls.splice(ls.indexOf(pick), 1);
        fate.set(pick.id, 'bought');
        take(pick, 1);
      }
    }
    if (seen) add(hourBuyers, item, 1);
  };

  const end = warm + hours * 60;
  const clock = () => o.exactClock ? 0 : r();
  let nextSnap = warm;
  for (let t = 0; t <= end; t++) {
    // Hourly snapshot, taken before this minute's trading: up to 3 minutes off the hour, stamped 0 to 5 minutes late.
    if (t === nextSnap) {
      const listings: Listing[] = [];
      for (const ls of live.values()) for (const l of ls) {
        listings.push({ id: l.id, itemId: l.item, quantity: l.qty, unitPrice: l.price, timeLeft: bucket(l.ends - t, o.longEndsAt, o.exactClock ? 0 : (r() - 0.5) * 6) });
      }
      snapshots.push({ at: (t + clock() * 5) * 60_000, listings });
      visible.push(snapshots.length === 1 ? new Map() : hourVisible);
      invisible.push(snapshots.length === 1 ? new Map() : hourInvisible);
      buyers.push(snapshots.length === 1 ? new Map() : hourBuyers);
      hourVisible = new Map(); hourInvisible = new Map(); hourBuyers = new Map();
      lastSnap = t;
      nextSnap = warm + (snapshots.length) * 60 + Math.round(clock() * 3);
    }
    for (const [item, ls] of live) {
      const ref = refs.get(item)!;
      // Expiries, some posted again within the hour at the going price. A bid only listing may be won by a bid.
      for (let i = ls.length - 1; i >= 0; i--) if (ls[i]!.ends <= t) {
        const l = ls[i]!;
        ls.splice(i, 1);
        if (bidOnly(l) && r() < spec.bidWinShare) { fate.set(l.id, 'won'); record(l, l.qty); if (l.posted < lastSnap) add(hourBuyers, item, 1); continue; }
        fate.set(l.id, 'expired');
        if (r() < spec.relistShare) pending.push({ at: t + 5 + Math.floor(r() * 55), item, qty: l.qty, dur: l.dur });
      }
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.at <= t && pending[i]!.item === item) { const p = pending.splice(i, 1)[0]!; post(t, item, p.qty, p.dur); }
      for (let n = poisson(spec.postsPerHour / 60); n > 0; n--) post(t, item, spec.postQty(r), duration(r));
      for (let n = poisson(spec.buyersPerHour / 60); n > 0; n--) buy(item, spec.buyQty(r), ref * (1.05 + r() * 0.55));
      // A sweep: one buyer takes a third of everything (commodities) or every copy (equipment) up to a price.
      if (r() < spec.sweepsPerHour / 60) {
        if (spec.commodity) buy(item, Math.ceil(ls.reduce((s, l) => s + l.qty, 0) * (0.25 + r() * 0.2)), ref * 3);
        else buy(item, ls.length, ref * (1.1 + r() * 0.3));
      }
      // Cancel to undercut: a seller near the front who is not the cheapest pulls the listing and posts again just
      // under the floor, mostly the same quantity and length, sometimes not.
      const priced = () => ls.filter(l => !bidOnly(l)).sort((a, b) => a.price! - b.price!);
      if (ls.length > 1 && r() < spec.undercutsPerHour / 60) {
        const sorted = priced();
        const front = sorted.slice(1, 6).filter(l => t - l.posted >= 10);
        if (front.length) {
          const l = front[Math.floor(r() * front.length)]!;
          const floor = sorted[0]!.price!;
          const price = Math.round(floor - Math.max(1, floor * r() * 0.02));
          ls.splice(ls.indexOf(l), 1);
          fate.set(l.id, price >= l.price! * 0.8 ? 'undercut' : 'cancelled');
          if (price >= l.price! * 0.8) {
            const qty = spec.commodity && r() < 0.3 ? Math.max(1, Math.round(l.qty * (0.5 + r()))) : l.qty;
            post(t, item, qty, r() < 0.3 ? duration(r) : l.dur, price);
          }
        }
      }
      // The cheapest seller pulls and posts again: to refresh the length, at the same price or a little lower.
      if (ls.length && r() < spec.refreshPerHour / 60) {
        const l = priced()[0];
        if (l && t - l.posted >= 10) {
          ls.splice(ls.indexOf(l), 1);
          fate.set(l.id, 'cancelled');
          post(t, item, spec.commodity && r() < 0.3 ? Math.max(1, Math.round(l.qty * (0.5 + r()))) : l.qty, r() < 0.5 ? duration(r) : l.dur, Math.max(1, Math.round(l.price! * (1 - r() * 0.03))));
        }
      }
      // Mass pull: most stacks at one price level go at once, half the units come back in other sizes (Salmon, B37).
      if (ls.length > 3 && r() < spec.massPullsPerHour / 60) {
        const sorted = priced();
        const level = sorted[Math.floor(r() * Math.min(sorted.length, 5))]!.price!;
        let back = 0;
        for (const l of sorted) if (l.price === level && r() < 0.7) { ls.splice(ls.indexOf(l), 1); fate.set(l.id, 'cancelled'); back += l.qty; }
        back = Math.round(back / 2);
        while (back > 0) { const q = spec.commodity ? Math.min(back, spec.postQty(r)) : 1; post(t, item, q, duration(r), level); back -= q; }
      }
      // Price war: a seller floods the market at 60 to 80 percent of the floor.
      if (ls.length && r() < spec.warsPerHour / 60) {
        const floor = floorOf(ls);
        if (floor !== Infinity) for (let k = 1 + Math.floor(r() * 4); k > 0; k--) post(t, item, spec.postQty(r), duration(r), Math.max(1, Math.round(floor * (0.6 + r() * 0.2))));
      }
      // Plain pulls of any listing, the cheapest included.
      for (let i = ls.length - 1; i >= 0; i--) if (r() < spec.cancelPerListingHour / 60) { fate.set(ls[i]!.id, 'cancelled'); ls.splice(i, 1); }
    }
  }
  return { type: o.type, commodity: spec.commodity, snapshots, visible, invisible, buyers, fate };
}
