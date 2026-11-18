import { describe, it, expect } from 'vitest';
import { netPerUnit, breakEvenPrice, deposit } from '../../src/rules/fees.ts';

describe('fees', () => {
  it('nets the Alliance 5 percent cut and a deposit', () => {
    // 4s80c Bright Baubles, vendor sell price 62c (example), deposit floor(62*0.15)=9
    expect(netPerUnit('alliance', 480, 62)).toBe(456 - 9);
  });
  it('Blackwater break even is about 17.6 percent above cost before deposit', () => {
    const be = breakEvenPrice('blackwater', 10000, 0); // deposit minimum 1c x5 = 5
    expect(be).toBe(Math.ceil(10005 / 0.85));
    expect(be / 10000).toBeGreaterThan(1.176);
    expect(be / 10000).toBeLessThan(1.178);
  });
  it('Alliance break even is about 5.3 percent above cost', () => {
    expect(breakEvenPrice('alliance', 10000, 0)).toBe(Math.ceil(10001 / 0.95));
  });
  it('deposit has a 1 copper minimum and a 5x Blackwater multiplier', () => {
    expect(deposit('alliance', 0)).toBe(1);
    expect(deposit('blackwater', 0)).toBe(5);
    expect(deposit('blackwater', 100)).toBe(75);
    expect(deposit('alliance', 100)).toBe(15);
  });
});
