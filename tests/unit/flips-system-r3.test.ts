/**
 * Whole system review round 3 (November 26): the competition window tolerance and the 5 percent margin rule.
 * Findings: scratchpad findings-system-r3.txt (H1 float boundary, L1 to L6 wording).
 */
import { describe, it, expect } from 'vitest';
import { A, inputsOf, ceruleanAtBens, DYE } from './flips.fixture.ts';
import { SellBook } from '../../src/flips/sellBook.ts';
import { newPerDayAt, undercutPerDay } from '../../src/flips/newPosts.ts';

describe('H1: 6 publishes summing to 5.999 hours are measured competition', () => {
  it('counts as measured, not as the sale counting fallback', () => {
    const inputs = inputsOf(ceruleanAtBens({ dyeDemand: { newPerDay: undefined } }));
    const post = new SellBook(inputsOf(ceruleanAtBens())).quote(A, DYE)!.undercutPrice;
    inputs.newPosts = new Map([[111, { hours: 5.999, byItem: new Map([[DYE, [[post, 6]] as Array<[number, number]>]]) }]]);
    const q = new SellBook(inputs).quote(A, DYE)!;
    expect(q.newDerived).toBe(false);
    expect(q.newPerHour).toBeCloseTo(6 / 5.999, 6);
  });
  it('helpers measure at 5.999 hours and still return null well under 6', () => {
    const np = (hours: number) => ({ hours, byItem: new Map([[1, [[100, 6]] as Array<[number, number]>]]), underFloor: new Map([[1, 6]]) });
    expect(newPerDayAt(np(5.999), 1, 100)).not.toBeNull();
    expect(undercutPerDay(np(5.999), 1)).not.toBeNull();
    expect(newPerDayAt(np(5.8), 1, 100)).toBeNull();
    expect(undercutPerDay(np(5.8), 1)).toBeNull();
  });
});

describe('the 5 percent margin counts only while the floor falls (November 26 decision)', () => {
  it('listings up to 5 percent above the post price compete on a falling floor, not on a steady or rising one', () => {
    const flat = new SellBook(inputsOf(ceruleanAtBens())).quote(A, DYE)!;
    const above = Math.round(flat.undercutPrice * 1.04);
    const posts = () => new Map([[111, { hours: 24, byItem: new Map([[DYE, [[above, 24]] as Array<[number, number]>]]) }]]);
    const steady = inputsOf(ceruleanAtBens()); steady.newPosts = posts();
    expect(new SellBook(steady).quote(A, DYE)!.newPerHour).toBe(0);
    const rising = inputsOf(ceruleanAtBens({ dyeDemand: { floorSlope: 5, floorFall: -0.04, floorSpanHours: 30 } })); rising.newPosts = posts();
    expect(new SellBook(rising).quote(A, DYE)!.newPerHour).toBe(0);
    const falling = inputsOf(ceruleanAtBens({ dyeDemand: { floorSlope: -5, floorFall: 0.04, floorSpanHours: 30 } })); falling.newPosts = posts();
    expect(new SellBook(falling).quote(A, DYE)!.newPerHour).toBe(1);
  });
});

describe('L1: a falling floor is never called rising', () => {
  it('a sweep above the floor does not set rising while the floor falls', () => {
    const falling = new SellBook(inputsOf(ceruleanAtBens({ dyeDemand: { sweepHigh: 100000, floorSlope: -5, floorFall: 0.04, floorSpanHours: 30 } }))).quote(A, DYE)!;
    expect(falling.rising).toBe(false);
    expect(falling.driftDrop).toBeGreaterThan(0);
  });
});
