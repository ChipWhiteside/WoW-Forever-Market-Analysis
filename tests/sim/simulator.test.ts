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
 *  - The rules must still beat the old ones when the simulator's guesses change: LONG ending at 8 instead of 12
 *    hours (the bucket edge not yet measured), no undercutting at all, and twice as much.
 *  - The sanity bound never breaches and no listing age contradicts its time left.
 */
import { describe, it, expect } from 'vitest';
import { score } from './evaluate.ts';

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
      const runs = [score(t, seeds, { longEndsAt: 480 }), ...undercut[t].map(u => score(t, seeds, { undercutsPerHour: u }))];
      for (const s of runs) {
        expect(s.newDayError).toBeLessThan(s.oldDayError);
        expect(Math.abs(s.newBias)).toBeLessThanOrEqual(0.12);
        expect(s.breaches).toBe(0);
      }
    }
  }, 120_000);
});
