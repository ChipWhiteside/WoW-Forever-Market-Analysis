/**
 * The sale counter against a simulated auction house with known truth (docs/flip-plan.md section 9, sale counting).
 * Print the full table with: npx tsx tests/sim/report.ts [seeds] [first seed]
 *
 * The simulator pulls every listing, the cheapest included, at the rates measured behind the cheapest on the real
 * snapshots (B38), and adds what the first version left out: the cheapest seller pulling to post again, mass pulls,
 * price wars, reposts of another size or length, bid only listings, equipment sweeps, equipment buyers taking any
 * copy they can afford, publish stamps 0 to 5 minutes late and bucket edges read a few minutes off.
 *
 * Pass marks come from 12 seeds (201 to 212): each is the pooled figure's mean plus about 3 standard errors of the
 * seed to seed spread, rounded out, and seeds 301 to 312 were checked to pass too. Measured (seed spread in brackets):
 *  - Deep commodities: daily error old 29.6%, new 6.6% (6.7 ± 0.3 per seed), bias +6.6%. Marks: bias within 10%,
 *    daily error at most 8% and at most 0.35 times the old rules'.
 *  - Equipment: daily error old 22.5%, new 14.0% (± 1.9), bias -2.5%. Marks: bias within 8%, daily error at most
 *    17% and at most 0.75 times the old rules'.
 *  - Thin commodities: the new rules do NOT beat the old here. Daily error old 26.6%, new 27.8% (28.0 ± 7.6 per seed),
 *    bias +22%. Pulls of the cheapest of a handful of listings read as sales, and nothing in a snapshot tells them
 *    apart; the old rules land closer only because throwing away every 2 hour listing offsets that leak. Marks: daily
 *    error no worse than 1.25 times the old rules', and the middle less expected pulls (net) biased within 15%
 *    (measured +5.8%, +11.1% on the second seed set).
 *  - The cautious low estimate (lowEstimate: the larger of a t bound on hourly net units and a Poisson bound on sale
 *    events) must be honest AND useful: at or under the true rate in at least 90% of item windows of 6 hours (the
 *    gate), 24 and 72 hours on every market, and on deep and equipment markets at least a stated share of the truth on
 *    average. Measured on 12 seeds, low over truth at 6 / 24 / 72 hours: deep 48 / 74 / 86%, equipment 46 / 69 / 80%,
 *    thin 13 / 35 / 63%, under truth 98 to 100%. Marks: deep at least 40% at 6 hours and 65% at 24; equipment at least
 *    38% and 60%.
 *  - Out of sample: seeds 301 to 312 must meet the same marks (measured deep 48 / 74%, equipment 45 / 68%, thin net
 *    bias +11%, thin under truth 93 to 98%).
 *  - The stack growth check never fires. Age conflicts appear only because the simulator reads bucket edges a few
 *    minutes off (a fresh 2 hour listing can read LONG); the counter then falls back to the time left alone, and with
 *    an exact clock there are none (the real snapshots have none either, B37).
 *  - Robustness (5 seeds each): LONG ending at 11 or 15 hours, no undercutting, twice as much, an exact clock, and
 *    sellers who almost never pull: deep and equipment still beat the old rules, thin stays within 1.3 times them,
 *    and the low estimate stays under the truth in at least 90% of windows.
 */
import { describe, it, expect } from 'vitest';
import { score } from './evaluate.ts';

const seeds = Array.from({ length: 12 }, (_, i) => 201 + i);
const outOfSample = Array.from({ length: 12 }, (_, i) => 301 + i);
const few = seeds.slice(0, 5);
const useful = { deep: { 6: 0.4, 24: 0.65 }, equipment: { 6: 0.38, 24: 0.6 } } as const;

describe('sale counter against simulated truth, sellers pulling at the measured rates', () => {
  for (const [label, set] of [['seeds 201 to 212', seeds], ['out of sample, seeds 301 to 312', outOfSample]] as const) {
    it(`deep commodities, ${label}: far better than the old rules, and a useful low estimate`, () => {
      const s = score('deep', [...set]);
      expect(Math.abs(s.newBias)).toBeLessThanOrEqual(0.1);
      expect(s.newDayError).toBeLessThanOrEqual(0.08);
      expect(s.newDayError).toBeLessThanOrEqual(s.oldDayError * 0.35);
      for (const W of [6, 24, 72]) expect(s.low[W]!.under).toBeGreaterThanOrEqual(0.9);
      expect(s.low[6]!.share).toBeGreaterThanOrEqual(useful.deep[6]);
      expect(s.low[24]!.share).toBeGreaterThanOrEqual(useful.deep[24]);
      expect(s.breaches).toBe(0);
    }, 60_000);

    it(`equipment, ${label}: better than the old rules, and a useful low estimate`, () => {
      const s = score('equipment', [...set]);
      expect(Math.abs(s.newBias)).toBeLessThanOrEqual(0.08);
      expect(s.newDayError).toBeLessThanOrEqual(0.17);
      expect(s.newDayError).toBeLessThanOrEqual(s.oldDayError * 0.75);
      for (const W of [6, 24, 72]) expect(s.low[W]!.under).toBeGreaterThanOrEqual(0.9);
      expect(s.low[6]!.share).toBeGreaterThanOrEqual(useful.equipment[6]);
      expect(s.low[24]!.share).toBeGreaterThanOrEqual(useful.equipment[24]);
      expect(s.breaches).toBe(0);
    }, 60_000);

    it(`thin commodities, ${label}: no better than the old rules, but the net middle and the low estimate are honest`, () => {
      const s = score('thin', [...set]);
      expect(s.newBias).toBeGreaterThan(0); // pulls read as sales: the leak is upward
      expect(s.newDayError).toBeLessThanOrEqual(s.oldDayError * 1.25);
      expect(Math.abs(s.netBias)).toBeLessThanOrEqual(0.15);
      for (const W of [6, 24, 72]) expect(s.low[W]!.under).toBeGreaterThanOrEqual(0.9);
      expect(s.breaches).toBe(0);
    }, 60_000);
  }

  it('holds when the bucket edge, undercutting, the clock or the pull rate differ', () => {
    const variants = [{ longEndsAt: 660 }, { longEndsAt: 900 }, { exactClock: true }];
    const undercut = { deep: [0, 2], thin: [0, 0.16], equipment: [0, 0.3] };
    const fewPulls = { deep: 0.003, thin: 0.004, equipment: 0.004 };
    for (const t of ['deep', 'thin', 'equipment'] as const) {
      const runs = [...variants.map(v => ({ v, s: score(t, few, v) })), ...undercut[t].map(u => ({ v: { undercutsPerHour: u }, s: score(t, few, { undercutsPerHour: u }) })),
        { v: { cancelPerListingHour: fewPulls[t] }, s: score(t, few, { cancelPerListingHour: fewPulls[t] }) }];
      for (const { v, s } of runs) {
        if (t === 'thin') expect(s.newDayError).toBeLessThanOrEqual(s.oldDayError * 1.3);
        else expect(s.newDayError).toBeLessThan(s.oldDayError);
        for (const W of [6, 24, 72]) expect(s.low[W]!.under).toBeGreaterThanOrEqual(0.9);
        expect(s.breaches).toBe(0);
        if ('exactClock' in v) expect(s.ageConflicts).toBe(0);
      }
    }
  }, 180_000);
});
