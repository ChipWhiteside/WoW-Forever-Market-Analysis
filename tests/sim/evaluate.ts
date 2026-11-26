/**
 * Runs the sale counter over simulated snapshots, old rules (the counter as of commit 39a8dda, kept verbatim in
 * old-aggregate.ts) against the current rules, and scores both against the simulator's truth. Also scores the
 * demand estimates built on the counter (src/analysis/history.ts): the middle less expected pulls (`net`) and the
 * cautious low estimate, which should sit under the true rate about 95 percent of the time.
 */
import { aggregate, nextSeen, type Seen, type Diagnostics } from '../../src/analysis/aggregate.ts';
import { rowPulls, lowEstimate } from '../../src/analysis/history.ts';
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
  breaches: number;
  ageConflicts: number;
  /** per seed daily errors, for the spread */
  perSeed: Array<{ seed: number; oldDayError: number; newDayError: number; netDayError: number; newBias: number; netBias: number }>;
}

const WINDOW = 72;

export function score(type: MarketType, seeds: number[], extra: Partial<SimOpts> = {}): Score {
  let truth = 0, invisible = 0, oldSum = 0, newSum = 0, netSum = 0, oldHour = 0, newHour = 0, hours = 0, buyers = 0, events = 0;
  let oldDayAll = 0, newDayAll = 0, netDayAll = 0, lowWindows = 0, lowUnder = 0, lowShareSum = 0;
  const diag: Diagnostics = { ageConflicts: 0, breaches: [] };
  const perSeed: Score['perSeed'] = [];
  for (const seed of seeds) {
    const run = simulate({ type, seed, ...extra });
    const kind = run.commodity ? 'commodities' : 'auctions';
    let seen: Map<number, Seen> | null = null;
    const day = new Map<string, { t: number; o: number; n: number; x: number }>();
    const win = new Map<string, { t: number; sold: number; ev: number; pulls: number; h: number }>();
    let sTruth = 0, sOld = 0, sNew = 0, sNet = 0;
    for (let k = 0; k < run.snapshots.length; k++) {
      const cur = run.snapshots[k]!;
      const prev = k > 0 ? run.snapshots[k - 1]! : null;
      const before = seen;
      seen = nextSeen(before, cur.listings, cur.at, prev, !!prev);
      if (!prev) continue;
      hours++;
      const n = aggregate(cur.listings, prev.listings, { commodity: run.commodity, prevAt: prev.at, curAt: cur.at, seen: before ?? undefined, diag });
      const o = oldAggregate(cur.listings, prev.listings, { commodity: run.commodity });
      const nm = new Map(n.map(s => [s.itemId, s]));
      const om = new Map(o.map(s => [s.itemId, Math.max(0, (s.goneUnitsNearFloor ?? 0) - (s.goneUnitsExpiringNearFloor ?? 0))]));
      const items = new Set([...nm.keys(), ...om.keys(), ...run.visible[k]!.keys()]);
      for (const item of items) {
        const t = run.visible[k]!.get(item) ?? 0, ov = om.get(item) ?? 0;
        const s = nm.get(item);
        const nv = s?.soldUnits ?? 0;
        const p = s ? rowPulls(kind, s) : { events: 0, units: 0 };
        const xv = nv - p.units;
        truth += t; oldSum += ov; newSum += nv; netSum += xv;
        sTruth += t; sOld += ov; sNew += nv; sNet += xv;
        oldHour += Math.abs(ov - t); newHour += Math.abs(nv - t);
        events += s?.soldEvents ?? 0;
        buyers += run.buyers[k]!.get(item) ?? 0;
        const key = `${item}:${Math.floor((k - 1) / 24)}`;
        const d = day.get(key) ?? { t: 0, o: 0, n: 0, x: 0 };
        d.t += t; d.o += ov; d.n += nv; d.x += xv;
        day.set(key, d);
        const wk = `${item}:${Math.floor((k - 1) / WINDOW)}`;
        const w = win.get(wk) ?? { t: 0, sold: 0, ev: 0, pulls: 0, h: 0 };
        w.t += t; w.sold += nv; w.ev += s?.soldEvents ?? 0; w.pulls += p.events; w.h += (cur.at - prev.at) / 3600_000;
        win.set(wk, w);
      }
      for (const v of run.invisible[k]!.values()) invisible += v;
    }
    let oldDay = 0, newDay = 0, netDay = 0;
    for (const d of day.values()) { oldDay += Math.abs(d.o - d.t); newDay += Math.abs(d.n - d.t); netDay += Math.abs(d.x - d.t); }
    oldDayAll += oldDay; newDayAll += newDay; netDayAll += netDay;
    for (const w of win.values()) {
      if (w.h < WINDOW - 2 || w.t <= 0) continue; // whole windows only, with sales to compare against
      const low = lowEstimate(w.ev, w.sold, w.pulls, w.h);
      const trueRate = (w.t / w.h) * 24;
      lowWindows++;
      if (low <= trueRate) lowUnder++;
      lowShareSum += low / trueRate;
    }
    const rel = (x: number) => sTruth > 0 ? x / sTruth : 0;
    perSeed.push({ seed, oldDayError: rel(oldDay), newDayError: rel(newDay), netDayError: rel(netDay), newBias: rel(sNew - sTruth), netBias: rel(sNet - sTruth) });
  }
  const rel = (x: number) => truth > 0 ? x / truth : 0;
  return {
    type, seeds: seeds.length, hours, truth, invisible, old: oldSum, new: newSum, net: Math.round(netSum),
    oldBias: rel(oldSum - truth), newBias: rel(newSum - truth), netBias: rel(netSum - truth),
    oldDayError: rel(oldDayAll), newDayError: rel(newDayAll), netDayError: rel(netDayAll), oldHourError: rel(oldHour), newHourError: rel(newHour),
    buyers, events, lowWindows, lowUnder: lowWindows ? lowUnder / lowWindows : 1, lowShare: lowWindows ? lowShareSum / lowWindows : 0,
    breaches: diag.breaches.length, ageConflicts: diag.ageConflicts, perSeed,
  };
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
