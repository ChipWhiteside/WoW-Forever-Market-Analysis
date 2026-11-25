/**
 * Runs the sale counter over simulated snapshots, old rules (the counter as of commit 39a8dda, kept verbatim in
 * old-aggregate.ts) against the current rules, and scores both against the simulator's truth.
 */
import { aggregate, nextSeen, type Seen, type Diagnostics } from '../../src/analysis/aggregate.ts';
import { aggregate as oldAggregate } from './old-aggregate.ts';
import { simulate, type MarketType, type SimOpts } from './market.ts';

export interface Score {
  type: MarketType;
  hours: number;
  /** units bought from listings visible at the previous snapshot, and inside the hour (invisible by design) */
  truth: number;
  invisible: number;
  old: number;
  new: number;
  /** (estimate - truth) / truth */
  oldBias: number;
  newBias: number;
  /** sum over item days of |estimate - truth|, over the sum of truth */
  oldDayError: number;
  newDayError: number;
  /** the same per item hour */
  oldHourError: number;
  newHourError: number;
  breaches: number;
  ageConflicts: number;
}

export function score(type: MarketType, seeds: number[], extra: Partial<SimOpts> = {}): Score {
  let truth = 0, invisible = 0, oldSum = 0, newSum = 0, oldDay = 0, newDay = 0, oldHour = 0, newHour = 0, hours = 0;
  const diag: Diagnostics = { ageConflicts: 0, breaches: [] };
  for (const seed of seeds) {
    const run = simulate({ type, seed, ...extra });
    let seen: Map<number, Seen> | null = null;
    const day = new Map<string, { t: number; o: number; n: number }>();
    for (let k = 0; k < run.snapshots.length; k++) {
      const cur = run.snapshots[k]!;
      const prev = k > 0 ? run.snapshots[k - 1]! : null;
      const before = seen;
      seen = nextSeen(before, cur.listings, cur.at, prev, !!prev);
      if (!prev) continue;
      hours++;
      const n = aggregate(cur.listings, prev.listings, { commodity: run.commodity, prevAt: prev.at, curAt: cur.at, seen: before ?? undefined, diag });
      const o = oldAggregate(cur.listings, prev.listings, { commodity: run.commodity });
      const nm = new Map(n.map(s => [s.itemId, s.soldUnits ?? 0]));
      const om = new Map(o.map(s => [s.itemId, Math.max(0, (s.goneUnitsNearFloor ?? 0) - (s.goneUnitsExpiringNearFloor ?? 0))]));
      const items = new Set([...nm.keys(), ...om.keys(), ...run.visible[k]!.keys()]);
      for (const item of items) {
        const t = run.visible[k]!.get(item) ?? 0, ov = om.get(item) ?? 0, nv = nm.get(item) ?? 0;
        truth += t; oldSum += ov; newSum += nv;
        oldHour += Math.abs(ov - t); newHour += Math.abs(nv - t);
        const key = `${item}:${Math.floor(k / 24)}`;
        const d = day.get(key) ?? { t: 0, o: 0, n: 0 };
        d.t += t; d.o += ov; d.n += nv;
        day.set(key, d);
      }
      for (const v of run.invisible[k]!.values()) invisible += v;
    }
    for (const d of day.values()) { oldDay += Math.abs(d.o - d.t); newDay += Math.abs(d.n - d.t); }
  }
  const rel = (x: number) => truth > 0 ? x / truth : 0;
  return {
    type, hours, truth, invisible, old: oldSum, new: newSum,
    oldBias: rel(oldSum - truth), newBias: rel(newSum - truth),
    oldDayError: rel(oldDay), newDayError: rel(newDay), oldHourError: rel(oldHour), newHourError: rel(newHour),
    breaches: diag.breaches.length, ageConflicts: diag.ageConflicts,
  };
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
export function table(scores: Score[]): string {
  const head = ['market', 'hours', 'true sold', 'unseen', 'old est', 'new est', 'old bias', 'new bias', 'old day err', 'new day err', 'old hour err', 'new hour err', 'breaches'];
  const rows = scores.map(s => [s.type, String(s.hours), String(s.truth), String(s.invisible), String(s.old), String(s.new), pct(s.oldBias), pct(s.newBias),
    pct(s.oldDayError).slice(1), pct(s.newDayError).slice(1), pct(s.oldHourError).slice(1), pct(s.newHourError).slice(1), String(s.breaches)]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const line = (r: string[]) => '| ' + r.map((c, i) => c.padEnd(w[i]!)).join(' | ') + ' |';
  return [line(head), '|' + w.map(x => '-'.repeat(x + 2)).join('|') + '|', ...rows.map(line)].join('\n');
}
