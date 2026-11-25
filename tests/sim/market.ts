/**
 * A small auction house simulator with known ground truth, for the sale counter only (docs/flip-plan.md section 9).
 *
 * Minute by minute it plays sellers posting 2, 8 and 24 hour listings, buyers, big sweeps, cancels to undercut,
 * plain cancels, expiries and expired listings posted again, then takes an hourly snapshot like Blizzard's.
 * Commodity buyers fill cheapest first through a buy window and partial buys shrink a stack. Equipment buyers pick
 * a listing. Truth per hour and item: units bought from listings that were up at the previous snapshot (what a
 * snapshot counter can see) and units bought from listings posted and bought inside the hour (invisible by design).
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
}

const pickWeighted = <T,>(r: () => number, items: Array<[T, number]>): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of items) { x -= w; if (x <= 0) return v; }
  return items[items.length - 1]![0];
};

/** Listing lengths as measured on Forever's new listings (B22): 17% 2 hour, 64% 8 hour, 18% 24 hour. */
const duration = (r: () => number) => pickWeighted(r, [[120, 17], [480, 64], [1440, 18]]);

export const SPECS: Record<MarketType, Spec> = {
  // Copper Ore like, sized to house 111's commodity markets of 50 to 500 listings (about 150 listings, 33 new posts
  // and 21 listings bought an hour): stacks of 1 to 20, many buyers, a sweep every day or so.
  deep: {
    commodity: true, ref: [80, 400], postsPerHour: 30,
    postQty: r => pickWeighted(r, [[1, 30], [2, 10], [3, 8], [5, 10], [10, 12], [20, 25], [1 + Math.floor(r() * 19), 5]]),
    buyersPerHour: 14, buyQty: r => 1 + Math.floor(-Math.log(1 - r()) * 10),
    sweepsPerHour: 0.04, undercutsPerHour: 1, cancelPerListingHour: 0.003, relistShare: 0.4,
  },
  // A dye or a rare reagent: a handful of listings (house 111 thin markets: about 3 up, a sale every 3 hours).
  thin: {
    commodity: true, ref: [500, 5000], postsPerHour: 0.5,
    postQty: r => pickWeighted(r, [[1, 50], [2, 20], [5, 20], [10, 10]]),
    buyersPerHour: 0.35, buyQty: r => pickWeighted(r, [[1, 60], [2, 20], [5, 20]]),
    sweepsPerHour: 0.01, undercutsPerHour: 0.08, cancelPerListingHour: 0.004, relistShare: 0.5,
  },
  // A green with a few dozen copies up (house 111 equipment markets of 10 to 60 copies: about 24 up, 4 new posts and
  // 1 bought an hour): quantity 1, buyers pick one.
  equipment: {
    commodity: false, ref: [2000, 50000], postsPerHour: 3,
    postQty: () => 1,
    buyersPerHour: 1.2, buyQty: () => 1,
    sweepsPerHour: 0, undercutsPerHour: 0.15, cancelPerListingHour: 0.004, relistShare: 0.4,
  },
};

interface Live { id: number; item: number; qty: number; price: number; posted: number; ends: number; dur: number }

export interface SimOpts {
  type: MarketType; seed: number; items?: number; hours?: number; warmupHours?: number; longEndsAt?: number;
  /** override how often a seller cancels to undercut, per item per hour (sensitivity runs) */
  undercutsPerHour?: number;
}

export interface SimRun {
  type: MarketType;
  commodity: boolean;
  /** hourly snapshots, `at` in ms */
  snapshots: Array<{ at: number; listings: Listing[] }>;
  /** truth[k] for the hour ending at snapshot k (k >= 1): item -> units */
  visible: Array<Map<number, number>>;
  invisible: Array<Map<number, number>>;
  /** what really ended each listing that vanished: bought, expired, undercut (cancelled and posted cheaper), cancelled */
  fate: Map<number, 'bought' | 'expired' | 'undercut' | 'cancelled'>;
}

/** Bucket for minutes left. `longEndsAt` is where LONG gives way to VERY_LONG, 720 (12 hours) or 480 (8 hours): not yet measured on Forever. */
export function bucket(minutesLeft: number, longEndsAt = 720): TimeLeft {
  if (minutesLeft < 30) return 'SHORT';
  if (minutesLeft < 120) return 'MEDIUM';
  if (minutesLeft < longEndsAt) return 'LONG';
  return 'VERY_LONG';
}

export function simulate(o: SimOpts): SimRun {
  const spec = { ...SPECS[o.type], ...(o.undercutsPerHour != null ? { undercutsPerHour: o.undercutsPerHour } : {}) };
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
  let lastSnap = -Infinity;
  const poisson = (lambda: number) => { let k = 0, p = Math.exp(-lambda), s = p; const u = r(); while (u > s && k < 50) { k++; p *= lambda / k; s += p; } return k; };
  const floorOf = (ls: Live[]) => ls.reduce((m, l) => Math.min(m, l.price), Infinity);

  const post = (t: number, item: number, qty: number, dur: number, at?: number) => {
    const ls = live.get(item)!;
    const ref = refs.get(item)!;
    let price: number;
    if (at != null) price = at;
    else {
      const floor = floorOf(ls);
      const reserve = ref * (0.8 + r() * 0.2);
      if (r() < 0.2) price = ref * (1.1 + r() * 0.7); // a lazy seller far up the ladder
      else if (floor !== Infinity && floor >= reserve) price = floor - Math.max(1, floor * r() * 0.02);
      else price = reserve * (1 + r() * 0.25);
    }
    ls.push({ id: nextId++, item, qty, price: Math.max(1, Math.round(price)), posted: t, ends: t + dur, dur });
  };
  // Trades of the hour now running; handed over at the snapshot that closes it.
  let hourVisible = new Map<number, number>(), hourInvisible = new Map<number, number>();
  const record = (l: Live, units: number) => {
    const m = l.posted < lastSnap ? hourVisible : hourInvisible; // posted before the last snapshot: it was in it
    m.set(l.item, (m.get(l.item) ?? 0) + units);
  };
  const buy = (item: number, want: number, maxPrice: number) => {
    const ls = live.get(item)!;
    if (spec.commodity) {
      ls.sort((a, b) => a.price - b.price || b.id - a.id); // cheapest first, newest first at one price (B23)
      while (want > 0 && ls.length && ls[0]!.price <= maxPrice) {
        const l = ls[0]!;
        const take = Math.min(want, l.qty);
        l.qty -= take; want -= take;
        record(l, take);
        if (l.qty === 0) { ls.shift(); fate.set(l.id, 'bought'); }
      }
    } else {
      const ok = ls.filter(l => l.price <= maxPrice).sort((a, b) => a.price - b.price);
      if (!ok.length) return;
      // Most buyers take the cheapest; some pick another copy within 20 percent of it (a better suffix).
      const near = ok.filter(l => l.price <= ok[0]!.price * 1.2);
      const pick = r() < 0.75 ? ok[0]! : near[Math.floor(r() * near.length)]!;
      ls.splice(ls.indexOf(pick), 1);
      fate.set(pick.id, 'bought');
      record(pick, 1);
    }
  };

  const end = warm + hours * 60;
  for (let t = 0; t <= end; t++) {
    // Hourly snapshot, taken before this minute's trading.
    if (t >= warm && (t - warm) % 60 === 0) {
      const listings: Listing[] = [];
      for (const ls of live.values()) for (const l of ls) listings.push({ id: l.id, itemId: l.item, quantity: l.qty, unitPrice: l.price, timeLeft: bucket(l.ends - t, o.longEndsAt) });
      snapshots.push({ at: t * 60_000, listings });
      visible.push(snapshots.length === 1 ? new Map() : hourVisible);
      invisible.push(snapshots.length === 1 ? new Map() : hourInvisible);
      hourVisible = new Map(); hourInvisible = new Map();
      lastSnap = t;
    }
    for (const [item, ls] of live) {
      const ref = refs.get(item)!;
      // Expiries, some posted again within the hour at the going price.
      for (let i = ls.length - 1; i >= 0; i--) if (ls[i]!.ends <= t) {
        const l = ls[i]!;
        ls.splice(i, 1);
        fate.set(l.id, 'expired');
        if (r() < spec.relistShare) pending.push({ at: t + 5 + Math.floor(r() * 55), item, qty: l.qty, dur: l.dur });
      }
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.at <= t && pending[i]!.item === item) { const p = pending.splice(i, 1)[0]!; post(t, item, p.qty, p.dur); }
      for (let n = poisson(spec.postsPerHour / 60); n > 0; n--) post(t, item, spec.postQty(r), duration(r));
      for (let n = poisson(spec.buyersPerHour / 60); n > 0; n--) buy(item, spec.buyQty(r), ref * (1.05 + r() * 0.55));
      // A sweep: one buyer takes a third of everything up to three times the usual price.
      if (r() < spec.sweepsPerHour / 60) buy(item, Math.ceil(ls.reduce((s, l) => s + l.qty, 0) * (0.25 + r() * 0.2)), ref * 3);
      // Cancel to undercut: a seller near the front who is not the cheapest pulls the listing and posts the same
      // quantity and length just under the floor.
      if (ls.length > 1 && r() < spec.undercutsPerHour / 60) {
        const sorted = [...ls].sort((a, b) => a.price - b.price);
        const front = sorted.slice(1, 6).filter(l => t - l.posted >= 10);
        if (front.length) {
          const l = front[Math.floor(r() * front.length)]!;
          const floor = sorted[0]!.price;
          const price = Math.round(floor - Math.max(1, floor * r() * 0.02));
          ls.splice(ls.indexOf(l), 1);
          fate.set(l.id, price >= l.price * 0.8 ? 'undercut' : 'cancelled');
          if (price >= l.price * 0.8) post(t, item, l.qty, l.dur, price);
        }
      }
      // Plain cancels.
      for (let i = ls.length - 1; i >= 0; i--) if (r() < spec.cancelPerListingHour / 60) { fate.set(ls[i]!.id, 'cancelled'); ls.splice(i, 1); }
    }
  }
  return { type: o.type, commodity: spec.commodity, snapshots, visible, invisible, fate };
}
