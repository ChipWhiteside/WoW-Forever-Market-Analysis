import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/store/db.ts';
import { flipAlertCycle, flushHeldFlipAlerts, formatFlipAlerts, judgeFlip, flipAlertSettings } from '../../src/flips/alerts.ts';
import { persistFlips } from '../../src/flips/persist.ts';
import type { Flip, FlipRunReport } from '../../src/flips/types.ts';
import { tempDir } from '../helpers.ts';

/** Best of the best Discord alerts (brief-refresh-alerts.md, Chip November 26). Never a real Discord call: fetch is mocked. */
const noon = Date.parse('2026-11-18T19:00:00Z'); // noon in Denver, outside the default 23 to 7 quiet hours
const night = Date.parse('2026-11-19T08:00:00Z'); // 1am Denver
const morning = Date.parse('2026-11-19T14:05:00Z'); // 7:05am Denver
const G = 10_000;

function flip(gold: number, over: Partial<Flip> & { risk?: 'low' | 'medium' | 'high'; strength?: number; hours?: number; key?: string } = {}): Flip {
  const { risk = 'low', strength = 82, hours = 24, key = `craft_auction:111:${Math.round(gold * 100)}`, ...rest } = over;
  const ep = Math.round(gold * G);
  const riskObj = { atStake: 5 * G, badCaseLoss: G, daysToSell: 0.5, level: risk, drivers: [] };
  const best = { label: 'best' as const, units: 20, cost: 5 * G, expectedSold: 18, expectedProfit: ep, minutes: 5, goldPerHour: null, risk: riskObj };
  return {
    key, kind: 'craft', family: 'craft_auction', itemId: 2589, name: 'Bolt of Linen Cloth', recipeId: 2963, sellHouseId: 111,
    buy: [{ kind: 'auction', itemId: 2589, name: 'Linen Cloth', units: 40, unitPrice: 10, who: 'Alliance auction house', houseId: 111, places: [] }],
    sell: { kind: 'auction', itemId: 2996, name: 'Bolt of Linen Cloth', units: 20, unitPrice: 900, who: 'Alliance auction house', houseId: 111, places: [] },
    perItem: Math.round(ep / 20), best, options: [best],
    sellQuote: { houseId: 111, claimPrice: 1000, netEach: 950, undercutPrice: 990, listed: 1000, basis: 'sold', ahead: 0, salesPerDayLow: 30, salesPerDayMid: 40,
      hoursWatched: hours, newPerHour: 0, sweepHigh: null, low3d: 900, cv: 0.05, strength, strengthParts: [], gates: [], rising: false },
    repeatable: true, opening: 'new', openHours72: 3, setup: null, shares: [], afterShared: { units: 20, expectedProfit: ep }, notes: [], dataAt: noon - 10 * 60_000,
    ...rest,
  };
}
const report = (at = noon): Pick<FlipRunReport, 'complete' | 'dataAt'> => ({ complete: true, dataAt: at - 10 * 60_000 });
function mockDiscord() {
  const sent: string[] = [];
  const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body)).content); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  return { sent, fetchFn };
}
const db = (): DB => openDb(tempDir(), ':memory:');

describe('flip alert gates', () => {
  const s = { good: 10 * G, amazing: 20 * G };
  it('25g low risk is Amazing, 12g Good, 9g nothing', () => {
    expect(judgeFlip(flip(25), s).tier).toBe('amazing');
    expect(judgeFlip(flip(12), s).tier).toBe('good');
    expect(judgeFlip(flip(9), s).tier).toBeNull();
  });
  it('high risk, learning, unknown learn source, low strength and held back never alert', () => {
    expect(judgeFlip(flip(25, { risk: 'high' }), s).tier).toBeNull();
    expect(judgeFlip(flip(25, { risk: 'medium' }), s).tier).toBe('amazing');
    expect(judgeFlip(flip(25, { hours: 5.9 }), s).tier).toBeNull();
    expect(judgeFlip(flip(25, { setup: { skill: 'Tailoring', rank: 75, cost: null, where: 'unknown', places: [], unknown: true } }), s).tier).toBeNull();
    expect(judgeFlip(flip(25, { strength: 74 }), s).tier).toBeNull();
    expect(judgeFlip(flip(25, { key: 'k' }), s, new Set(['k'])).tier).toBeNull();
  });
  it('the shared pass number counts when it is lower', () => {
    expect(judgeFlip({ ...flip(25), afterShared: { units: 5, expectedProfit: 9 * G } }, s).tier).toBeNull();
  });
  it('bars come from settings in gold, 10 and 20 by default', () => {
    const d = db();
    expect(flipAlertSettings(d)).toEqual({ good: 10 * G, amazing: 20 * G });
    d.prepare(`INSERT INTO settings (key, value) VALUES ('alert_good_gold', '5'), ('alert_amazing_gold', '15')`).run();
    expect(flipAlertSettings(d)).toEqual({ good: 5 * G, amazing: 15 * G });
  });
});

describe('flip alert cycle', () => {
  it('two qualifying flips in one run: both sent in one message, Amazing first, logged', async () => {
    const d = db(); const { sent, fetchFn } = mockDiscord();
    const r = await flipAlertCycle(d, 'https://discord.example/hook', [flip(12, { key: 'a' }), flip(25, { key: 'b' }), flip(9, { key: 'c' })], report(), { now: noon, fetchFn, appUrl: 'http://localhost:4317' });
    expect(r).toMatchObject({ sent: 2, posts: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.indexOf('AMAZING')).toBeLessThan(sent[0]!.indexOf('**Good**'));
    expect(sent[0]).toContain('Crafting');
    expect(sent[0]).toContain('Buy: 40 Linen Cloth');
    expect(sent[0]).toContain('Sell: 20 at');
    expect(sent[0]).toContain('http://localhost:4317/#flips');
    const logged = d.prepare('SELECT key, tier, expected_profit, per_item, units FROM flip_alerts ORDER BY key').all();
    expect(logged).toEqual([{ key: 'a', tier: 'good', expected_profit: 12 * G, per_item: 6000, units: 20 }, { key: 'b', tier: 'amazing', expected_profit: 25 * G, per_item: 12500, units: 20 }]);
  });
  it('a repeat within 24 hours is held; one grown by 25 percent is sent; after 24 hours it is sent again', async () => {
    const d = db(); const { sent, fetchFn } = mockDiscord();
    const hook = 'https://discord.example/hook';
    expect((await flipAlertCycle(d, hook, [flip(12, { key: 'a' })], report(), { now: noon, fetchFn })).sent).toBe(1);
    expect((await flipAlertCycle(d, hook, [flip(14, { key: 'a' })], report(noon + 3600_000), { now: noon + 3600_000, fetchFn })).sent).toBe(0);
    expect((await flipAlertCycle(d, hook, [flip(15, { key: 'a' })], report(noon + 7200_000), { now: noon + 7200_000, fetchFn })).sent).toBe(1);
    expect((await flipAlertCycle(d, hook, [flip(15, { key: 'a' })], report(noon + 27 * 3600_000), { now: noon + 27 * 3600_000, fetchFn })).sent).toBe(1);
    expect(sent).toHaveLength(3);
  });
  it('an incomplete or stale run sends nothing', async () => {
    const d = db(); const { sent, fetchFn } = mockDiscord();
    expect((await flipAlertCycle(d, 'h', [flip(25)], { complete: false, dataAt: noon }, { now: noon, fetchFn })).skipped).toBe('run incomplete');
    expect((await flipAlertCycle(d, 'h', [flip(25)], { complete: true, dataAt: noon - 91 * 60_000 }, { now: noon, fetchFn })).skipped).toBe('data not fresh');
    expect(sent).toHaveLength(0);
  });
  it('quiet hours hold an alert, then send it when they end if the flip is still live', async () => {
    const d = db(); const { sent, fetchFn } = mockDiscord();
    const f = { ...flip(25, { key: 'q' }), dataAt: night - 600_000 };
    const runAt = night;
    persistFlips(d, { flips: [f], heldBack: [], report: { at: runAt, dataAt: night - 600_000, ms: 1, complete: true, houses: [111], items: 1, recipesTried: 1, flips: 1, byFamily: {}, heldBackByReason: {}, suspects: [] } }, runAt);
    const r = await flipAlertCycle(d, 'h', [f], { complete: true, dataAt: night - 600_000 }, { now: night, fetchFn });
    expect(r).toMatchObject({ sent: 0, skipped: 'quiet hours', held: 1 });
    expect(await flushHeldFlipAlerts(d, 'h', { now: night + 600_000, fetchFn })).toBeNull(); // still quiet
    expect(sent).toHaveLength(0);
    // 7:05am: the latest run is fresh again (a new publish at 7am), the flip is still on the list.
    persistFlips(d, { flips: [{ ...f, dataAt: morning - 300_000 }], heldBack: [], report: { at: morning, dataAt: morning - 300_000, ms: 1, complete: true, houses: [111], items: 1, recipesTried: 1, flips: 1, byFamily: {}, heldBackByReason: {}, suspects: [] } }, morning);
    const out = await flushHeldFlipAlerts(d, 'h', { now: morning + 60_000, fetchFn });
    expect(out?.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await flushHeldFlipAlerts(d, 'h', { now: morning + 120_000, fetchFn })).toBeNull(); // nothing left pending
  });
  it('a held alert whose flip is gone when quiet hours end is dropped', async () => {
    const d = db(); const { sent, fetchFn } = mockDiscord();
    await flipAlertCycle(d, 'h', [flip(25, { key: 'gone' })], { complete: true, dataAt: night - 600_000 }, { now: night, fetchFn });
    expect((await flushHeldFlipAlerts(d, 'h', { now: morning, fetchFn }))?.skipped).toBe('held alerts no longer live');
    expect(sent).toHaveLength(0);
  });
});

describe('flip alert message size', () => {
  it('every post stays under 2,000 characters, splitting when needed, every block whole', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ flip: flip(10 + i, { key: `k${i}` }), tier: (10 + i >= 20 ? 'amazing' : 'good') as 'good' | 'amazing', profit: (10 + i) * G }));
    const posts = formatFlipAlerts(many, 'http://localhost:4317');
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) expect(p.body.length).toBeLessThan(2000);
    expect(posts.flatMap(p => p.keys).sort()).toEqual(many.map(m => m.flip.key).sort());
    expect(posts[0]!.body).toContain('(1 of');
  });
  it('one flip with a huge buy list still fits one post', () => {
    const buy = Array.from({ length: 200 }, (_, i) => ({ kind: 'auction' as const, itemId: i, name: `Reagent number ${i}`, units: 3, unitPrice: 123, who: 'Alliance auction house', places: [] }));
    const posts = formatFlipAlerts([{ flip: flip(30, { buy }), tier: 'amazing', profit: 30 * G }], null);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.length).toBeLessThan(2000);
    expect(posts[0]!.body).toContain('rest in the app');
  });
  it('a failed Discord post logs nothing as sent, so it is tried again next run', async () => {
    const d = db();
    const fetchFn = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect((await flipAlertCycle(d, 'h', [flip(25)], report(), { now: noon, fetchFn })).skipped).toBe('discord failed');
    expect(d.prepare('SELECT COUNT(*) n FROM flip_alerts').get()).toEqual({ n: 0 });
  });
});
