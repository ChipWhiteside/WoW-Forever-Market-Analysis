import { describe, it, expect } from 'vitest';
import { netPerUnit, breakEvenPrice, deposit, listingPlan } from '../../src/rules/fees.ts';

describe('fees', () => {
  it('deposit matches Chip\'s Coarse Stone listing: 6c, 24c, 72c', () => {
    expect(deposit('alliance', 15, 1, 2)).toBe(6);
    expect(deposit('alliance', 15, 1, 8)).toBe(24);
    expect(deposit('alliance', 15, 1, 24)).toBe(72);
  });
  it('deposit has a 1 copper minimum and an assumed 5x at Blackwater', () => {
    expect(deposit('alliance', 0)).toBe(1);
    expect(deposit('blackwater', 0)).toBe(5);
    expect(deposit('blackwater', 15, 1, 2)).toBe(30);
  });
  it('net per unit is the price after the cut; the deposit is refunded on a sale', () => {
    expect(netPerUnit('alliance', 480)).toBe(456);
    expect(netPerUnit('blackwater', 160)).toBe(136);
  });
  it('Blackwater break even is about 17.6 percent above cost, Alliance about 5.3', () => {
    expect(breakEvenPrice('blackwater', 10000) / 10000).toBeCloseTo(1.1765, 3);
    expect(breakEvenPrice('alliance', 10000)).toBe(10527);
  });
});

describe('listing plan', () => {
  it('a fast mover that sells out in 2 hours lists for 2 hours', () => {
    const p = listingPlan('alliance', 15, 20, 100, 150);
    expect(p.best).toBe(2);
    expect(p.options[0]!.sellsOut).toBe(true);
  });
  it('a slow mover picks the length that earns the most after expired deposits', () => {
    // 1 an hour, stack of 20, 30c profit each, vendor price 15c
    const p = listingPlan('alliance', 15, 30, 1, 20);
    // 2h: 2 sold*30 - 18*6 = -48; 8h: 8*30 - 12*24 = -48; 24h: 20*30 = 600 sells out
    expect(p.options.map(o => o.expectedProfit)).toEqual([-48, -48, 600]);
    expect(p.best).toBe(24);
  });
  it('an expensive deposit on a slow seller can make a shorter listing better', () => {
    // vendor price 1g: deposits 40s, 1g 60s, 4g 80s per unit. 0.05 an hour, stack of 3, 50s profit each
    const p = listingPlan('alliance', 10000, 5000, 0.05, 3);
    expect(p.best).toBe(2);
  });
});
