/**
 * The sale counter against a simulated auction house with known truth (docs/flip-plan.md section 9, sale counting).
 * Print the full table with: npx tsx tests/sim/report.ts
 *
 * Pass marks, and why:
 *  - Bias within 10 percent on every market type. Demand feeds a cautious lower bound, so a small steady bias is
 *    tolerable; the old rules were 10 to 31 percent low.
 *  - Daily error (sum over item days of |estimate - truth| over truth), set at about 1.5 times what the current
 *    rules measure, so seed noise does not fail the build, and each mark demands a clear cut from the old rules:
 *    deep commodities at most 8 percent and at most 0.35 times the old error (measured 4.9 against 31.5),
 *    thin commodities at most 10 percent and 0.75 times (6.4 against 12.4),
 *    equipment at most 12 percent and 0.75 times (8.9 against 14.7).
 *  - The rules must still beat the old ones when the simulator's guesses change: LONG ending at 11 or 15 hours
 *    (the ends of the span measured on Forever, B33), no undercutting at all, and twice as much.
 *  - Plain cancels at the rates measured on the real snapshots (B38), applied to every listing including the
 *    cheapest (a cautious case, P15): every cancel of a listing at the front reads as a sale, so the new rules run
 *    high there (measured +6 percent deep, +16 thin, +19 equipment), while the old rules land near zero only because
 *    throwing away every 2 hour listing cancels the leak out. Marks: deep still beats the old rules and stays within
 *    10 percent; thin and equipment stay under +25 percent, so a rule change that widens the leak fails.
 *  - The sanity bound never breaches and no listing age contradicts its time left.
 */
import { describe, it, expect } from 'vitest';
import { score, MEASURED_CANCELS } from './evaluate.ts';

const seeds = [101, 102, 103];
const types = ['deep', 'thin', 'equipment'] as const;
const marks = { deep: { day: 0.08, vsOld: 0.35 }, thin: { day: 0.1, vsOld: 0.75 }, equipment: { day: 0.12, vsOld: 0.75 } };

describe('sale counter against simulated truth', () => {
  for (const t of types) {
    it(`${t}: bias, daily error and the cut against the old rules meet the pass marks`, () => {
      const s = score(t, seeds);
      expect(Math.abs(s.newBias)).toBeLessThanOrEqual(0.1);
      expect(s.newDayError).toBeLessThanOrEqual(marks[t].day);
      expect(s.newDayError).toBeLessThanOrEqual(s.oldDayError * marks[t].vsOld);
      expect(s.newHourError).toBeLessThan(s.oldHourError);
      expect(s.breaches).toBe(0);
      expect(s.ageConflicts).toBe(0);
    }, 60_000);
  }

  it('still beats the old rules when the bucket edge or the amount of undercutting differs', () => {
    const undercut = { deep: [0, 2], thin: [0, 0.16], equipment: [0, 0.3] };
    for (const t of types) {
      const runs = [score(t, seeds, { longEndsAt: 660 }), score(t, seeds, { longEndsAt: 900 }), ...undercut[t].map(u => score(t, seeds, { undercutsPerHour: u }))];
      for (const s of runs) {
        expect(s.newDayError).toBeLessThan(s.oldDayError);
        expect(Math.abs(s.newBias)).toBeLessThanOrEqual(0.12);
        expect(s.breaches).toBe(0);
        expect(s.ageConflicts).toBe(0);
      }
    }
  }, 120_000);

  it('plain cancels at the measured rates: deep still beats the old rules, the leak on thin and equipment stays bounded', () => {
    for (const t of types) {
      const s = score(t, seeds, { cancelPerListingHour: MEASURED_CANCELS[t] });
      expect(s.breaches).toBe(0);
      expect(s.ageConflicts).toBe(0);
      if (t === 'deep') {
        expect(s.newDayError).toBeLessThan(s.oldDayError * 0.35);
        expect(Math.abs(s.newBias)).toBeLessThanOrEqual(0.1);
      } else {
        expect(s.newBias).toBeGreaterThan(0); // cancels read as sales: the leak is upward, never a loss of sales
        expect(s.newBias).toBeLessThanOrEqual(0.25);
      }
    }
  }, 60_000);
});
