import { describe, it, expect } from 'vitest';
import { poissonLower, LOW_CONFIDENCE } from '../../src/analysis/history.ts';

describe('cautious sales estimate', () => {
  it('one sided lower bound of a Poisson mean matches the chi square values', () => {
    expect(LOW_CONFIDENCE).toBe(0.95);
    expect(poissonLower(0)).toBe(0);
    expect(poissonLower(1)).toBeCloseTo(-Math.log(0.95), 6); // 1 - e^-m = 0.05
    expect(poissonLower(3)).toBeCloseTo(1.635 / 2, 2); // chi square 6 degrees of freedom, 5th percentile
    expect(poissonLower(10)).toBeCloseTo(10.851 / 2, 2); // 20 degrees of freedom
    expect(poissonLower(100)).toBeCloseTo(84.1, 0);
    expect(poissonLower(10, 0.8)).toBeCloseTo(14.578 / 2, 2); // other levels work too
  });
  it('few sales give a low number, many sales come close to what was seen', () => {
    expect(poissonLower(1) / 1).toBeLessThan(0.06);
    expect(poissonLower(3) / 3).toBeLessThan(0.3);
    expect(poissonLower(1000) / 1000).toBeGreaterThan(0.94);
    let last = 0;
    for (let k = 1; k <= 200; k++) { const v = poissonLower(k); expect(v).toBeGreaterThan(last); expect(v).toBeLessThan(k); last = v; }
  });
});
