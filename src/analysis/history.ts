import type { DB } from '../store/db.ts';
import type { Demand } from '../detectors/types.ts';

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
 * Share of listings sellers pull each hour where no buyer can reach, from the real snapshots (B38). A pull of the
 * listing at the front reads as a sale, and nothing in a snapshot tells it apart (P15), so the cautious estimate
 * takes off the pulls expected at this rate. Thin commodity markets are 5 listings or fewer.
 */
export const PULL_RATE = { deep: 0.022, thin: 0.026, equipment: 0.035 } as const;
/** Equipment copies within this many times the floor read as sold when pulled (the counter's band, EQUIP_SOLD_BAND). */
const PULL_BAND = 1.25;

/**
 * Pulls expected to read as sales in one hourly row, in events and units. Commodities: only the stack at the front can
 * be pulled and still read as bought (anything behind a stack still up reads as pulled), so the units at the floor
 * times the pull rate. Equipment: every copy within 1.25 times the floor, times the pull rate; each is one event and
 * one unit. Same arithmetic as the SQL in demandByItem, kept here for the simulator.
 */
export function rowPulls(kind: 'commodities' | 'auctions', s: { listings: number; unitsAtFloor: number; floor: number | null; ladder: Array<[number, number]> }): { events: number; units: number } {
  if (kind === 'commodities') {
    const rate = s.listings <= 5 ? PULL_RATE.thin : PULL_RATE.deep;
    return { events: s.listings > 0 ? rate : 0, units: rate * s.unitsAtFloor };
  }
  if (s.floor == null) return { events: 0, units: 0 };
  let band = 0;
  for (const [p, u] of s.ladder) if (p <= s.floor * PULL_BAND) band += u;
  return { events: PULL_RATE.equipment * band, units: PULL_RATE.equipment * band };
}

/**
 * The cautious units sold a day: the 95 percent lower bound of the sale events seen, less the pulls expected to have
 * read as sales, times units per event, over hours watched. Never below 0.
 */
export function lowEstimate(events: number, units: number, pullEvents: number, hours: number): number {
  if (events <= 0 || hours <= 0) return 0;
  return (Math.max(0, poissonLower(events) - pullEvents) * (units / events) / hours) * 24;
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
 * 6 hours (one busy hour is not a typical hour of the day). `lowPerDay` is the cautious one the flip ranking uses:
 * the 95 percent one sided lower bound of the number of sale EVENTS (buyers, not units: a sweep of 116 stacks is
 * one sale), less the pulls of the front listing expected to have read as sales (P15), times the average units per
 * event, over hours watched. Under 6 differenced publishes it is null, never projected. `netPerDay` is the middle
 * one less the units those pulls would add.
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
  const rows = db.prepare(`SELECT item_id, SUM(${SOLD}) sold, SUM(COALESCE(sold_value, 0)) value, COUNT(*) n, SUM(${events}) events,
     SUM(COALESCE(new_near_floor, new_units, 0)) fresh, SUM(COALESCE(gone_units_expiring_near_floor, 0)) pulled, MAX(s.kind) kind,
     SUM(CASE WHEN s.kind = 'commodities' THEN (CASE WHEN listings > 5 THEN ${PULL_RATE.deep} ELSE ${PULL_RATE.thin} END) * (listings > 0)
       ELSE ${PULL_RATE.equipment} * COALESCE((SELECT SUM(json_extract(j.value, '$[1]')) FROM json_each(ladder) j WHERE json_extract(j.value, '$[0]') <= floor * ${PULL_BAND}), 0) END) pull_events,
     SUM(CASE WHEN s.kind = 'commodities' THEN (CASE WHEN listings > 5 THEN ${PULL_RATE.deep} ELSE ${PULL_RATE.thin} END) * units_at_floor
       ELSE ${PULL_RATE.equipment} * COALESCE((SELECT SUM(json_extract(j.value, '$[1]')) FROM json_each(ladder) j WHERE json_extract(j.value, '$[0]') <= floor * ${PULL_BAND}), 0) END) pull_units
     FROM item_stats JOIN snapshots s ON s.id = item_stats.snapshot_id
     WHERE item_stats.house_id = ? AND item_stats.published_at >= ? AND item_stats.published_at <= ? AND gone_units IS NOT NULL AND sold_value IS NOT NULL GROUP BY item_id`)
    .all(houseId, since, now) as Array<{ item_id: number; sold: number; value: number; n: number; events: number | null; fresh: number | null; pulled: number | null; kind: string; pull_events: number; pull_units: number }>;
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
    // Never project from under 6 hours of watching: one sale in the first hour is not 24 a day.
    out.set(r.item_id, { unitsPerDay: (r.sold / Math.max(h, 6)) * 24, hours: Math.round(h * 10) / 10, snapshots: r.n, soldPrice: r.sold > 0 && r.value > 0 ? Math.round(r.value / r.sold) : null,
      recentSales: rc?.sold ?? 0, recentSoldPrice: rc && rc.sold > 0 && rc.value > 0 ? Math.round(rc.value / rc.sold) : null, floorCv: steady.get(r.item_id) ?? null,
      lowPerDay: kc.n < MIN_PUBLISHES_LOW ? null : lowEstimate(ev, r.sold, r.pull_events ?? 0, h),
      newPerDay: ((r.fresh ?? 0) / h) * 24, pulledPerDay: ((r.pulled ?? 0) / h) * 24,
      pullEvents: r.pull_events ?? 0, netPerDay: (Math.max(0, r.sold - (r.pull_units ?? 0)) / Math.max(h, 6)) * 24,
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
