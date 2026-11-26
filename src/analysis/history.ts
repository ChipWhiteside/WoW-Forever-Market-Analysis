import type { DB } from '../store/db.ts';
import type { Demand } from '../detectors/types.ts';
import { THIN_LISTINGS, REPOST_UNITS } from './aggregate.ts';

/** Units judged sold in one item_stats row: the current rules' count, or near floor sales for rows written before it. */
const SOLD = `COALESCE(sold_units, MAX(0, COALESCE(gone_units_near_floor, 0) - COALESCE(gone_units_expiring_near_floor, 0)))`;
/**
 * Sale events in one row: listings judged bought (sold_events, written when that column exists). Without the column
 * (it needs a migration, not made yet): equipment is one unit per listing, so units are events; for commodities one
 * hour with sales counts as one event, which is never more than the listings bought, so the bound only gets more cautious.
 */
const FALLBACK_EVENTS = `CASE WHEN s.kind = 'commodities' THEN (${SOLD} > 0) ELSE ${SOLD} END`;
const hasSoldEvents = (db: DB) =>
  (db.prepare(`SELECT COUNT(*) n FROM pragma_table_info('item_stats') WHERE name = 'sold_events'`).get() as { n: number }).n > 0;

/** Cautious level for the low estimate of sales: the true rate is above it 95 percent of the time. */
export const LOW_CONFIDENCE = 0.95;
/** Under this many hours watched, the low estimate is not projected to a day at all. */
export const MIN_HOURS_LOW = 6;
/** Hourly publishes are not exactly an hour apart (6 of them can sum to 5.99 hours), so the gate counts differenced
 * publishes of the item's kind rather than summed hours. */
export const MIN_PUBLISHES_LOW = 6;

/**
 * An item whose whole front at the floor was replaced in at least this share of the window's publishes is flagged
 * (frontReplacedHourly). Not every one: a reposter who skips one hour in 24, or one hour a buyer moves the floor,
 * cleared the flag and the low then read 7 times the truth (round 3 test, D2).
 */
export const FRONT_REPLACED_SHARE = 0.8;
/** Rows this far before the window still feed LAG, so the window's first row has the publish before it (D1). */
const LOOKBACK_MS = 3 * 3600_000;

/**
 * Share of listings sellers pull each hour where no buyer can reach, from the real snapshots (B38). A pull of the
 * stack at the front of a commodity market reads as a sale, and nothing in a snapshot tells it apart (P15).
 * Thin commodity markets are 5 listings or fewer. Equipment needs no allowance: there the counter also misses buys
 * (a dearer copy picked, a buy erased as an undercut) and in the simulator those offset the pulls (B36, B42).
 */
export const PULL_RATE = { deep: 0.022, thin: 0.026, equipment: 0.035 } as const;

/** Pull rate that applies to one hourly row: commodities only. */
export function rowPullRate(kind: 'commodities' | 'auctions', listings: number): number {
  if (kind !== 'commodities' || listings <= 0) return 0;
  return listings <= 5 ? PULL_RATE.thin : PULL_RATE.deep;
}

/**
 * Units judged sold in one row less the units expected to be pulls of the front read as sales (rate from the previous
 * publish's row). Deep markets: rate * sold / (1 - rate). Many stacks share the floor there and only those ahead of
 * the first survivor read as bought, so the units at the floor overstate what a pull can fake; scaling the units
 * judged sold never takes off more than was counted (B43). Thin markets (5 listings or fewer): rate * the previous
 * front's units, the expectation whether or not anything sold; tied to sold units it left a +19% bias in the
 * simulator against +6% this way. A thin row can be below 0 (an expectation); sums are what count.
 * Equipment rows are left as they are.
 */
export function rowNet(kind: 'commodities' | 'auctions', prevListings: number, prevUnitsAtFloor: number, sold: number): number {
  const r = rowPullRate(kind, prevListings);
  if (r === 0) return sold;
  return sold - (prevListings <= 5 ? r * prevUnitsAtFloor : r * sold / (1 - r));
}

/** Longest gap between two publishes across which a pull and a post again are matched. */
const ACROSS_GAP_MS = 1.6 * 3600_000;

/**
 * A thin market pulled before one publish and posted again after it (round 3: a seller pulling at :50 and posting at
 * :10 read 69 a day on a thin commodity and 5.5 on thin equipment, with no buyer). The units judged sold in a row are
 * a repost when they left the item with no listing at all, and the next publish, differenced and at most 1.6 hours
 * on, brings new units near the floor within 25 percent of them at a floor at most 25 percent over the floor before.
 * Without the empty market it erased real sales 4 to 1 in the simulator (221 bought units against 58 pulled); with
 * it, 47 against 6 over 24 seeds, under 0.5 percent of thin units sold. Mirrors the SQL in demandByItem.
 */
export function repostedAcross(prevListings: number, prevFloor: number | null, sold: number, listings: number,
  next: { newNearFloor: number | null; floor: number | null; gapMs: number; differenced: boolean } | null): boolean {
  if (!next || prevListings > THIN_LISTINGS || sold <= 0 || listings > 0 || !next.differenced || next.gapMs > ACROSS_GAP_MS) return false;
  if (prevFloor == null || next.floor == null || next.floor > prevFloor * (1 + REPOST_UNITS)) return false;
  return Math.abs((next.newNearFloor ?? 0) - sold) <= sold * REPOST_UNITS;
}

/** One sided Student t quantile (Cornish Fisher expansion around the normal; within 0.002 of tables from 5 degrees of freedom). */
export function tQuantile(conf: number, df: number): number {
  const z = normalQuantile(conf);
  if (!Number.isFinite(df) || df > 1e6) return z;
  const z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}

/** What the cautious estimate is built from, over one item's watched window. */
export interface LowInputs {
  /** sale events seen (buyers: a run of stacks is one) and units judged sold */
  events: number;
  units: number;
  /** events expected to be pulls of the front stack read as sales (commodities) */
  pullEvents: number;
  /** hours watched and differenced publishes of the item's kind; publishes with no row for the item count as 0 sold */
  hours: number;
  publishes: number;
  /** sum and sum of squares of the hourly net units (rowNet) over the item's rows */
  sumNet: number;
  sumNetSq: number;
}

/**
 * The cautious units sold a day, the larger of two lower bounds (B42):
 *  - Hourly: the one sided 95 percent t bound on the mean of hourly net units over every watched publish, hours with
 *    nothing sold included: max(0, mean - t * sd / sqrt(n)). It tracks volume, so a steady busy market reads near its
 *    middle.
 *  - Events: the 95 percent Poisson lower bound of sale events, less the pulls expected to read as sales, times
 *    units per event. It is the floor for thin items, where hourly figures are mostly zero.
 */
export function lowEstimate(x: LowInputs): number {
  if (x.hours <= 0) return 0;
  const events = x.events > 0 ? (Math.max(0, poissonLower(x.events) - x.pullEvents) * (x.units / x.events) / x.hours) * 24 : 0;
  let hourly = 0;
  const n = x.publishes;
  if (n >= 2) {
    const mean = x.sumNet / n;
    const sd = Math.sqrt(Math.max(0, (x.sumNetSq - n * mean * mean) / (n - 1)));
    hourly = Math.max(0, mean - tQuantile(LOW_CONFIDENCE, n - 1) * sd / Math.sqrt(n)) * (n / x.hours) * 24;
  }
  return Math.max(events, hourly);
}

/**
 * Pulls expected to read as sale events over a window of commodity rows: the pull rate of each row times the chance
 * the hour had no real sale (a pull inside a real run adds no event, by the run rule), estimated as the share of
 * publishes without a sale.
 */
export function expectedPullEvents(rateSum: number, events: number, publishes: number): number {
  if (publishes <= 0) return 0;
  return rateSum * Math.max(0, 1 - events / publishes);
}

/**
 * One sided lower confidence bound of a Poisson mean from `k` observed events: the mean m for which seeing k or
 * more events has chance 1 - conf. Exact (bisection on the Poisson tail) up to 60 events, Wilson and Hilferty above.
 * At 95 percent: 0 events give 0, 1 gives 0.051, 3 give 0.82, 10 give 5.4, 100 give 84.
 */
export function poissonLower(k: number, conf = LOW_CONFIDENCE): number {
  if (k <= 0) return 0;
  const alpha = 1 - conf;
  if (k > 60) {
    const z = normalQuantile(conf);
    return k * Math.pow(1 - 1 / (9 * k) - z / (3 * Math.sqrt(k)), 3);
  }
  // P(X >= k | m) = 1 - sum_{i<k} e^-m m^i / i!, rising in m. Find where it equals alpha.
  const tail = (m: number) => {
    let term = Math.exp(-m), sum = term;
    for (let i = 1; i < k; i++) { term *= m / i; sum += term; }
    return 1 - sum;
  };
  let lo = 0, hi = k;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (tail(mid) < alpha) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Standard normal quantile (Acklam's rational approximation, error under 1.2e-9). */
function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = p < 0.5 ? p : 1 - p;
  let x: number;
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    x = (((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1);
    x = -x;
  } else {
    const r = q - 0.5, t = r * r;
    x = (((((a[0]! * t + a[1]!) * t + a[2]!) * t + a[3]!) * t + a[4]!) * t + a[5]!) * r / (((((b[0]! * t + b[1]!) * t + b[2]!) * t + b[3]!) * t + b[4]!) * t + 1);
  }
  return p < 0.5 ? x : -x;
}

/**
 * Estimated units sold per day, per item, for one house, under the current sale rules (src/analysis/aggregate.ts):
 * listing age decides expiry, commodity sweeps count, cancels to undercut do not. Plain cancels of the cheapest
 * listing still leak in, so this is provisional by nature (spec 12.1).
 * The window stretches backward after a gap: it always looks at the last `snapshots` differenced publishes.
 *
 * Two estimates. `unitsPerDay` is the middle one: units sold over hours watched, never projected from under
 * 6 hours (one busy hour is not a typical hour of the day). `lowPerDay` is the cautious one the flip ranking uses
 * (lowEstimate): the larger of a t bound on hourly net units and a Poisson bound on sale events. Under 6 differenced
 * publishes it is null, never projected, and it is null when the whole front was replaced in 80 percent of hours or more.
 * `netPerDay` is the middle less the share expected to be pulls (commodities). `hourlyMean` and `hourlySd` describe
 * hourly sold units over every watched publish, zero hours included, for the flip engine's overnight queue.
 */
export function demandByItem(db: DB, houseId: number, opts: { hours?: number; now?: number } = {}): Map<number, Demand> {
  const now = opts.now ?? Date.now();
  const hours = opts.hours ?? 72;
  // Every query is bounded to rows at or before `now`, so a run for a past hour never sees later sales.
  const since = now - hours * 3600_000;
  // Hours actually covered by differencing, per kind: the sum of the gaps between consecutive publishes
  // that were differenced. Gaps over 1.6 hours are never differenced, so outages cannot inflate demand.
  // Only rows counted with a sold price (they carry sold_value). Rows from before it counted expiries and
  // relists as sales, so they are left out rather than mixed in.
  const snaps = db.prepare(`SELECT kind, SUM(diff_hours) h, COUNT(*) n FROM snapshots WHERE house_id = ? AND published_at >= ? AND published_at <= ? AND diff_hours IS NOT NULL
     AND id IN (SELECT DISTINCT snapshot_id FROM item_stats WHERE house_id = ? AND published_at >= ? AND published_at <= ? AND sold_value IS NOT NULL) GROUP BY kind`)
    .all(houseId, since, now, houseId, since, now) as Array<{ kind: string; h: number; n: number }>;
  const covered = Math.max(0, ...snaps.map(s => s.h ?? 0));
  const coveredBy = new Map(snaps.map(s => [s.kind, { h: s.h ?? 0, n: s.n }]));
  const out = new Map<number, Demand>();
  if (covered <= 0) return out;
  const events = hasSoldEvents(db) ? `COALESCE(sold_events, ${FALLBACK_EVENTS})` : FALLBACK_EVENTS;
  // New units other sellers posted near the floor; rows written before that was measured fall back to all new units.
  // Units near the floor that left without being bought (cancelled, expired, pulled to post again).
  // Per row: the pull rate (commodities only, rowPullRate), units less the share expected to be pulls (rowNet), and
  // whether the whole front at the floor was replaced: the floor held at the same price as the row before, units
  // were judged sold, and every unit now at the floor is new (frontReplacedHourly).
  // The previous publish's row of the same item gives the front that could be pulled (all rows, differenced or not).
  const rate = (l: string) => `(CASE WHEN kind = 'commodities' AND ${l} > 0 THEN (CASE WHEN ${l} > 5 THEN ${PULL_RATE.deep} ELSE ${PULL_RATE.thin} END) ELSE 0 END)`;
  const rows = db.prepare(`WITH a AS (SELECT item_stats.*, s.kind kind,
       LAG(floor) OVER w prev_floor, LAG(listings) OVER w prev_listings, LAG(units_at_floor) OVER w prev_front,
       LEAD(item_stats.published_at) OVER w next_at, LEAD(gone_units) OVER w next_gone, LEAD(new_near_floor) OVER w next_new, LEAD(floor) OVER w next_floor
     FROM item_stats JOIN snapshots s ON s.id = item_stats.snapshot_id
     WHERE item_stats.house_id = ? AND item_stats.published_at >= ? AND item_stats.published_at <= ?
     WINDOW w AS (PARTITION BY item_stats.item_id ORDER BY item_stats.published_at)),
     r0 AS (SELECT a.*, ${SOLD} x0, ${events.replace(/s\.kind/g, 'kind')} ev0 FROM a
       WHERE published_at >= ? AND gone_units IS NOT NULL AND sold_value IS NOT NULL),
     r1 AS (SELECT r0.*, (COALESCE(prev_listings, listings) <= ${THIN_LISTINGS} AND x0 > 0 AND listings = 0 AND next_gone IS NOT NULL AND next_at - published_at <= ${ACROSS_GAP_MS}
       AND prev_floor IS NOT NULL AND next_floor IS NOT NULL AND next_floor <= prev_floor * (1 + ${REPOST_UNITS})
       AND ABS(COALESCE(next_new, 0) - x0) <= x0 * ${REPOST_UNITS}) across FROM r0),
     r AS (SELECT r1.*, CASE WHEN across THEN 0 ELSE x0 END x, CASE WHEN across THEN 0 ELSE ev0 END ev, CASE WHEN across THEN 0 ELSE sold_value END sv,
       ${rate('COALESCE(prev_listings, listings)')} rate FROM r1),
     q AS (SELECT r.*, x - (CASE WHEN rate = 0 THEN 0 WHEN COALESCE(prev_listings, listings) <= 5 THEN rate * COALESCE(prev_front, units_at_floor) ELSE rate * x / (1 - rate) END) net1 FROM r)
     SELECT item_id, SUM(x) sold, SUM(COALESCE(sv, 0)) value, COUNT(*) n, SUM(ev) events, SUM(across) across,
     SUM(COALESCE(new_near_floor, new_units, 0)) fresh, SUM(COALESCE(gone_units_expiring_near_floor, 0)) pulled, MAX(kind) kind,
     SUM(rate) rate_sum, SUM(x * x) sold_sq, SUM(net1) net, SUM(net1 * net1) net_sq,
     SUM(CASE WHEN prev_floor = floor AND x > 0 AND units_at_floor > 0 AND COALESCE(new_near_floor, 0) >= units_at_floor THEN 1 ELSE 0 END) replaced
     FROM q GROUP BY item_id`)
    .all(houseId, since - LOOKBACK_MS, now, since) as Array<{ item_id: number; sold: number; value: number; n: number; events: number | null; fresh: number | null; pulled: number | null; kind: string;
      rate_sum: number; sold_sq: number; net: number; net_sq: number; replaced: number; across: number }>;
  const recent = new Map((db.prepare(`SELECT item_id, SUM(${SOLD}) sold, SUM(COALESCE(sold_value, 0)) value
     FROM item_stats WHERE house_id = ? AND published_at >= ? AND published_at <= ? AND gone_units IS NOT NULL AND sold_value IS NOT NULL GROUP BY item_id`).all(houseId, now - 24 * 3600_000, now) as Array<{ item_id: number; sold: number; value: number }>)
    .map(r => [r.item_id, r]));
  // Steadiness: how far the hourly floor wanders over the window (standard deviation over mean).
  const steady = new Map((db.prepare(`SELECT item_id, AVG(floor) m, AVG(floor * floor) m2, COUNT(*) n FROM item_stats WHERE house_id = ? AND published_at >= ? AND published_at <= ? AND floor IS NOT NULL GROUP BY item_id`)
    .all(houseId, since, now) as Array<{ item_id: number; m: number; m2: number; n: number }>).map(r => [r.item_id, r.n >= 6 && r.m > 0 ? Math.sqrt(Math.max(0, r.m2 - r.m * r.m)) / r.m : null]));
  // The bad case price: the lowest hourly floor in the last 3 days, whatever the demand window.
  const low3d = new Map((db.prepare(`SELECT item_id, MIN(floor) f FROM item_stats WHERE house_id = ? AND published_at >= ? AND published_at <= ? AND floor IS NOT NULL GROUP BY item_id`)
    .all(houseId, now - 72 * 3600_000, now) as Array<{ item_id: number; f: number }>).map(r => [r.item_id, r.f]));
  // The last hour's sweep: the latest differenced publish of each kind, if it is under 2 hours old.
  const sweep = new Map((db.prepare(`SELECT item_id, sweep_high FROM item_stats WHERE sweep_high IS NOT NULL AND snapshot_id IN
     (SELECT MAX(id) FROM snapshots WHERE house_id = ? AND diff_hours IS NOT NULL AND published_at >= ? AND published_at <= ? GROUP BY kind)`)
    .all(houseId, now - 2 * 3600_000, now) as Array<{ item_id: number; sweep_high: number }>).map(r => [r.item_id, r.sweep_high]));
  for (const r of rows) {
    const rc = recent.get(r.item_id);
    const ev = r.events ?? 0;
    const unitsPerEvent = ev > 0 ? r.sold / ev : null;
    // Hours watched of this item's kind (commodities and equipment publish separately).
    const kc = coveredBy.get(r.kind) ?? { h: covered, n: 0 };
    const h = kc.h > 0 ? kc.h : covered;
    // Every watched publish of the kind counts, those with no row for this item as 0 sold.
    const n = Math.max(kc.n, r.n);
    const pullEvents = expectedPullEvents(r.rate_sum ?? 0, ev, n);
    const mean = r.sold / n;
    const hourlySd = n >= 2 ? Math.sqrt(Math.max(0, ((r.sold_sq ?? 0) - n * mean * mean) / (n - 1))) : null;
    // One seller pulling the whole front and posting it again every hour reads as the front selling every hour
    // (tests/sim/reposter.test.ts): middle 11 to 14 times the truth. No snapshot field tells it apart, so the
    // cautious estimate is withheld for such an item.
    const frontReplacedHourly = n >= MIN_PUBLISHES_LOW && r.replaced >= FRONT_REPLACED_SHARE * n;
    const unitsPerDay = (r.sold / Math.max(h, 6)) * 24;
    // Never above the middle (which is never projected from under 6 hours).
    let lowPerDay: number | null = kc.n < MIN_PUBLISHES_LOW ? null
      : Math.min(unitsPerDay, lowEstimate({ events: ev, units: r.sold, pullEvents, hours: h, publishes: n, sumNet: r.net ?? 0, sumNetSq: r.net_sq ?? 0 }));
    let lowNote: string | undefined;
    if (frontReplacedHourly) { lowPerDay = null; lowNote = 'the whole front at the floor was replaced in 80 percent of hours or more: a seller pulling and posting again reads as sales, so no cautious figure'; }
    // Never project from under 6 hours of watching: one sale in the first hour is not 24 a day.
    out.set(r.item_id, { unitsPerDay, hours: Math.round(h * 10) / 10, snapshots: r.n, soldPrice: r.sold > 0 && r.value > 0 ? Math.round(r.value / r.sold) : null,
      recentSales: rc?.sold ?? 0, recentSoldPrice: rc && rc.sold > 0 && rc.value > 0 ? Math.round(rc.value / rc.sold) : null, floorCv: steady.get(r.item_id) ?? null,
      lowPerDay, lowNote, frontReplacedHourly,
      newPerDay: ((r.fresh ?? 0) / h) * 24, pulledPerDay: ((r.pulled ?? 0) / h) * 24,
      pullEvents, netPerDay: (Math.max(0, r.net ?? 0) / Math.max(h, 6)) * 24,
      hourlyMean: r.sold / h, hourlySd, hourlyHours: Math.round(h * 10) / 10,
      sweepHigh: sweep.get(r.item_id) ?? null, low3d: low3d.get(r.item_id) ?? null, soldUnits: r.sold, saleEvents: ev, unitsPerEvent, hoursWatched: Math.round(h * 10) / 10 });
  }
  return out;
}

export interface Typical { typicalFloor: number; readings: number }

/**
 * Typical floor: the median of hourly floors over the window. Exists only after `minReadings` readings.
 * A statistic of the floor over time, never a median of listing prices (spec 5).
 */
export function typicalFloors(db: DB, houseId: number, opts: { hours?: number; minReadings?: number; now?: number } = {}): Map<number, Typical> {
  const now = opts.now ?? Date.now();
  const since = now - (opts.hours ?? 72) * 3600_000;
  const min = opts.minReadings ?? 24;
  const rows = db.prepare(`SELECT item_id, floor FROM item_stats WHERE house_id = ? AND published_at >= ? AND floor IS NOT NULL ORDER BY item_id, floor`)
    .all(houseId, since) as Array<{ item_id: number; floor: number }>;
  const out = new Map<number, Typical>();
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j]!.item_id === rows[i]!.item_id) j++;
    const n = j - i;
    if (n >= min) {
      const mid = i + Math.floor(n / 2);
      const median = n % 2 ? rows[mid]!.floor : Math.round((rows[mid - 1]!.floor + rows[mid]!.floor) / 2);
      out.set(rows[i]!.item_id, { typicalFloor: median, readings: n });
    }
    i = j;
  }
  return out;
}

/** How many hourly readings exist for this house, for the "learning, N of 24 hours" cold start label. */
export function readingsSoFar(db: DB, houseId: number, hours = 72, now = Date.now()): number {
  const r = db.prepare(`SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM snapshots WHERE house_id = ? AND published_at >= ? GROUP BY kind)`).get(houseId, now - hours * 3600_000) as { n: number | null };
  return r.n ?? 0;
}
