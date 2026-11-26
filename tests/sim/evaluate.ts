/**
 * Runs the sale counter over simulated snapshots, old rules (the counter as of commit 39a8dda, kept verbatim in
 * old-aggregate.ts) against the current rules, and scores both against the simulator's truth. Also scores the
 * demand estimates built on the counter (src/analysis/history.ts): the middle less expected pulls (`net`) and the
 * cautious low estimate, which should sit under the true rate about 95 percent of the time.
 */
import { aggregate, nextSeen, type Seen, type Diagnostics, type ItemStat } from '../../src/analysis/aggregate.ts';
import { rowNet, rowPullRate, lowEstimate, expectedPullEvents, repostedAcross } from '../../src/analysis/history.ts';
import { aggregate as oldAggregate } from './old-aggregate.ts';
import { simulate, MEASURED_CANCELS, type MarketType, type SimOpts } from './market.ts';

export { MEASURED_CANCELS };

export interface Score {
  type: MarketType;
  seeds: number;
  hours: number;
  /** units bought from listings visible at the previous snapshot, and inside the hour (invisible by design) */
  truth: number;
  invisible: number;
  old: number;
  new: number;
  /** the new count less the pulls expected to read as sales */
  net: number;
  /** (estimate - truth) / truth */
  oldBias: number;
  newBias: number;
  netBias: number;
  /** sum over item days of |estimate - truth|, over the sum of truth */
  oldDayError: number;
  newDayError: number;
  netDayError: number;
  /** the same per item hour */
  oldHourError: number;
  newHourError: number;
  /** buyers seen against sale events counted */
  buyers: number;
  events: number;
  /** item windows of 72 hours: share where the cautious low estimate is at or under the true rate, and its mean share of it */
  lowWindows: number;
  lowUnder: number;
  lowShare: number;
  /** the same for windows of 6 (the gate), 24 and 72 hours. `zero`: windows whose truth is 0 (nothing bought), and
   * `falseSale`: of those, the share where the low is above 0 (a sale that never happened). */
  low: Record<number, { windows: number; under: number; share: number; zero: number; falseSale: number }>;
  breaches: number;
  ageConflicts: number;
  /** per seed daily errors, for the spread */
  perSeed: Array<{ seed: number; oldDayError: number; newDayError: number; netDayError: number; newBias: number; netBias: number }>;
}

export const WINDOWS = [6, 24, 72] as const;

export function score(type: MarketType, seeds: number[], extra: Partial<SimOpts> = {}): Score {
  let truth = 0, invisible = 0, oldSum = 0, newSum = 0, netSum = 0, oldHour = 0, newHour = 0, hours = 0, buyers = 0, events = 0;
  let oldDayAll = 0, newDayAll = 0, netDayAll = 0;
  const lowAcc = new Map<number, Acc>(WINDOWS.map(w => [w, { windows: 0, under: 0, share: 0, zero: 0, falseSale: 0 }]));
  const diag: Diagnostics = { ageConflicts: 0, breaches: [] };
  const perSeed: Score['perSeed'] = [];
  for (const seed of seeds) {
    const run = simulate({ type, seed, ...extra });
    const kind = run.commodity ? 'commodities' : 'auctions';
    // Every publish's rows first: a pull before one publish and a post again after it is judged from the next row
    // (repostedAcross, as demandByItem does).
    const statsAt: Array<Map<number, ItemStat> | null> = [];
    let seen: Map<number, Seen> | null = null;
    for (let k = 0; k < run.snapshots.length; k++) {
      const cur = run.snapshots[k]!, prev = k > 0 ? run.snapshots[k - 1]! : null;
      const before = seen;
      seen = nextSeen(before, cur.listings, cur.at, prev, !!prev);
      statsAt.push(prev ? new Map(aggregate(cur.listings, prev.listings, { commodity: run.commodity, prevAt: prev.at, curAt: cur.at, seen: before ?? undefined, diag }).map(s => [s.itemId, s])) : null);
    }
    let prevStats: Map<number, ItemStat> | null = null;
    const day = new Map<string, { t: number; o: number; n: number; x: number }>();
    type Win = { t: number; sold: number; ev: number; rate: number; net: number; netSq: number };
    const win = new Map<string, Win>();
    const winHours = new Map<string, { h: number; n: number }>();
    let sTruth = 0, sOld = 0, sNew = 0, sNet = 0;
    for (let k = 0; k < run.snapshots.length; k++) {
      const cur = run.snapshots[k]!;
      const prev = k > 0 ? run.snapshots[k - 1]! : null;
      if (!prev) continue;
      hours++;
      const o = oldAggregate(cur.listings, prev.listings, { commodity: run.commodity });
      const nm = statsAt[k]!;
      const nextM = statsAt[k + 1] ?? null;
      if (!prevStats) prevStats = new Map(aggregate(prev.listings, null, { commodity: run.commodity }).map(s => [s.itemId, s]));
      const ps = prevStats;
      const om = new Map(o.map(s => [s.itemId, Math.max(0, (s.goneUnitsNearFloor ?? 0) - (s.goneUnitsExpiringNearFloor ?? 0))]));
      const items = new Set([...nm.keys(), ...om.keys(), ...run.visible[k]!.keys()]);
      for (const item of items) {
        const t = run.visible[k]!.get(item) ?? 0, ov = om.get(item) ?? 0;
        const s = nm.get(item);
        const before = ps.get(item) ?? s;
        const nx = nextM?.get(item);
        const across = !!s && repostedAcross(before?.listings ?? 0, before?.floor ?? null, s.soldUnits ?? 0, s.listings,
          nx ? { newNearFloor: nx.newNearFloor, floor: nx.floor, gapMs: run.snapshots[k + 1]!.at - cur.at, differenced: true } : null);
        const nv = across ? 0 : s?.soldUnits ?? 0;
        const ev = across ? 0 : s?.soldEvents ?? 0;
        const xv = s ? rowNet(kind, before?.listings ?? 0, before?.unitsAtFloor ?? 0, nv) : 0;
        const rate = s ? rowPullRate(kind, before?.listings ?? 0) : 0;
        truth += t; oldSum += ov; newSum += nv; netSum += xv;
        sTruth += t; sOld += ov; sNew += nv; sNet += xv;
        oldHour += Math.abs(ov - t); newHour += Math.abs(nv - t);
        events += ev;
        buyers += run.buyers[k]!.get(item) ?? 0;
        const key = `${item}:${Math.floor((k - 1) / 24)}`;
        const d = day.get(key) ?? { t: 0, o: 0, n: 0, x: 0 };
        d.t += t; d.o += ov; d.n += nv; d.x += xv;
        day.set(key, d);
        for (const W of WINDOWS) {
          const wk = `${W}:${item}:${Math.floor((k - 1) / W)}`;
          const w = win.get(wk) ?? { t: 0, sold: 0, ev: 0, rate: 0, net: 0, netSq: 0 };
          w.t += t; w.sold += nv; w.ev += ev; w.rate += rate; w.net += xv; w.netSq += xv * xv;
          win.set(wk, w);
        }
      }
      for (const W of WINDOWS) {
        const hk = `${W}:${Math.floor((k - 1) / W)}`;
        const wh = winHours.get(hk) ?? { h: 0, n: 0 };
        wh.h += (cur.at - prev.at) / 3600_000; wh.n++;
        winHours.set(hk, wh);
      }
      for (const v of run.invisible[k]!.values()) invisible += v;
      prevStats = nm;
    }
    let oldDay = 0, newDay = 0, netDay = 0;
    for (const d of day.values()) { oldDay += Math.abs(d.o - d.t); newDay += Math.abs(d.n - d.t); netDay += Math.abs(d.x - d.t); }
    oldDayAll += oldDay; newDayAll += newDay; netDayAll += netDay;
    for (const [wk, w] of win) {
      const [W, , idx] = wk.split(':');
      const wh = winHours.get(`${W}:${idx}`)!;
      if (wh.n < Number(W)) continue; // whole windows only
      const low = lowEstimate({ events: w.ev, units: w.sold, pullEvents: expectedPullEvents(w.rate, w.ev, wh.n), hours: wh.h, publishes: wh.n, sumNet: w.net, sumNetSq: w.netSq });
      const a = lowAcc.get(Number(W))!;
      // Nothing bought: any low above 0 is a false sale, which the share under the truth below never sees.
      if (w.t <= 0) { a.zero++; if (low > 0) a.falseSale++; continue; }
      const trueRate = (w.t / wh.h) * 24;
      a.windows++;
      if (low <= trueRate) a.under++;
      a.share += low / trueRate;
    }
    const rel = (x: number) => sTruth > 0 ? x / sTruth : 0;
    perSeed.push({ seed, oldDayError: rel(oldDay), newDayError: rel(newDay), netDayError: rel(netDay), newBias: rel(sNew - sTruth), netBias: rel(sNet - sTruth) });
  }
  const rel = (x: number) => truth > 0 ? x / truth : 0;
  return {
    type, seeds: seeds.length, hours, truth, invisible, old: oldSum, new: newSum, net: Math.round(netSum),
    oldBias: rel(oldSum - truth), newBias: rel(newSum - truth), netBias: rel(netSum - truth),
    oldDayError: rel(oldDayAll), newDayError: rel(newDayAll), netDayError: rel(netDayAll), oldHourError: rel(oldHour), newHourError: rel(newHour),
    buyers, events, ...lowFields(lowAcc),
    breaches: diag.breaches.length, ageConflicts: diag.ageConflicts, perSeed,
  };
}

type Acc = { windows: number; under: number; share: number; zero: number; falseSale: number };
function lowFields(acc: Map<number, Acc>) {
  const low: Score['low'] = {};
  for (const [W, a] of acc) low[W] = { windows: a.windows, under: a.windows ? a.under / a.windows : 1, share: a.windows ? a.share / a.windows : 0,
    zero: a.zero, falseSale: a.zero ? a.falseSale / a.zero : 0 };
  return { low, lowWindows: low[72]!.windows, lowUnder: low[72]!.under, lowShare: low[72]!.share };
}

/** The low estimate's usefulness per window length: share of windows at or under the truth, and mean low over truth. */
export function lowTable(scores: Score[]): string {
  const head = ['market', ...WINDOWS.flatMap(W => [`${W}h windows`, `${W}h under truth`, `${W}h low / truth`, `${W}h no sale windows`, `${W}h false sale`])];
  const rows = scores.map(s => [s.type, ...WINDOWS.flatMap(W => [String(s.low[W]!.windows), `${(s.low[W]!.under * 100).toFixed(0)}%`, `${(s.low[W]!.share * 100).toFixed(0)}%`,
    String(s.low[W]!.zero), `${(s.low[W]!.falseSale * 100).toFixed(0)}%`])]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const line = (r: string[]) => '| ' + r.map((c, i) => c.padEnd(w[i]!)).join(' | ') + ' |';
  return [line(head), '|' + w.map(x => '-'.repeat(x + 2)).join('|') + '|', ...rows.map(line)].join('\n');
}

/** Mean and standard deviation of one per seed measure. */
export function spread(s: Score, f: (p: Score['perSeed'][number]) => number): { mean: number; sd: number } {
  const xs = s.perSeed.map(f);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean, sd };
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
export function table(scores: Score[]): string {
  const head = ['market', 'true sold', 'unseen', 'old bias', 'new bias', 'net bias', 'old day err', 'new day err', 'net day err', 'buyers', 'events', 'low under truth', 'low / truth', 'breaches'];
  const rows = scores.map(s => [s.type, String(s.truth), String(s.invisible), pct(s.oldBias), pct(s.newBias), pct(s.netBias),
    pct(s.oldDayError).slice(1), pct(s.newDayError).slice(1), pct(s.netDayError).slice(1), String(s.buyers), String(s.events),
    `${(s.lowUnder * 100).toFixed(0)}% of ${s.lowWindows}`, pct(s.lowShare).slice(1), String(s.breaches)]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const line = (r: string[]) => '| ' + r.map((c, i) => c.padEnd(w[i]!)).join(' | ') + ' |';
  return [line(head), '|' + w.map(x => '-'.repeat(x + 2)).join('|') + '|', ...rows.map(line)].join('\n');
}
