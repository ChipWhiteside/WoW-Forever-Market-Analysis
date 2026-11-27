import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { flipAlertCycle } from '../../src/flips/alerts.ts';
import { reviewAlerts } from '../../src/flips/alertReview.ts';
import { sendDiscord } from '../../src/alerts/discord.ts';
import { takeInstanceLock } from '../../src/engine/instanceLock.ts';
import type { Flip, FlipRunReport } from '../../src/flips/types.ts';
import { tempDir } from '../helpers.ts';

/** Round 3 finding: two processes on one database. A second handle on the same file acts as a second process (own token, same pid). */
const noon = Date.parse('2026-11-18T19:00:00Z');
const G = 10_000;
const report: Pick<FlipRunReport, 'complete' | 'dataAt'> = { complete: true, dataAt: noon - 10 * 60_000 };
function flip(gold: number, key: string): Flip {
  const ep = Math.round(gold * G);
  const risk = { atStake: 5 * G, badCaseLoss: G, daysToSell: 0.5, level: 'low' as const, drivers: [] };
  const best = { label: 'best' as const, units: 20, cost: 5 * G, expectedSold: 18, expectedProfit: ep, minutes: 5, goldPerHour: null, risk };
  return {
    key, kind: 'craft', family: 'craft_auction', itemId: 2996, name: 'Bolt of Linen Cloth', recipeId: 2963, sellHouseId: 111,
    buy: [], sell: { kind: 'auction', itemId: 2996, name: 'Bolt of Linen Cloth', units: 20, unitPrice: 900, who: 'Alliance auction house', houseId: 111, places: [] },
    perItem: Math.round(ep / 20), best, options: [best],
    sellQuote: { houseId: 111, claimPrice: 1000, netEach: 950, undercutPrice: 990, listed: 1000, basis: 'sold', ahead: 0, salesPerDayLow: 30, salesPerDayMid: 40,
      hoursWatched: 24, newPerHour: 0, sweepHigh: null, low3d: 900, cv: 0.05, strength: 82, strengthParts: [], gates: [], rising: false },
    repeatable: true, opening: 'new', openHours72: 3, setup: null, shares: [], afterShared: { units: 20, expectedProfit: ep }, notes: [], dataAt: noon - 10 * 60_000,
  };
}
const flips = () => Array.from({ length: 6 }, (_, i) => flip(12 + i, `k${i}`));
const ok = () => new Response(null, { status: 204 });
const count = (xs: string[]) => xs.join('\n').match(/\*\*(AMAZING|Good)\*\*/g)?.length ?? 0;

describe('pending owner', () => {
  it('a second process during the first one\'s send never doubles', async () => {
    const dir = tempDir();
    const a = openDb(dir), b = openDb(dir);
    const delivered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow = (async (_u: string, init: RequestInit) => { delivered.push(JSON.parse(String(init.body)).content); await gate; return ok(); }) as unknown as typeof fetch;
    const first = flipAlertCycle(a, 'h', flips(), report, { now: noon, fetchFn: slow });
    await new Promise(r => setTimeout(r, 30));
    const fast = (async (_u: string, init: RequestInit) => { delivered.push(JSON.parse(String(init.body)).content); return ok(); }) as unknown as typeof fetch;
    const second = await flipAlertCycle(b, 'h', flips(), report, { now: noon + 60_000, fetchFn: fast });
    expect(second.skipped).toBe('nothing new');
    release();
    await first;
    expect(count(delivered)).toBe(6);
    expect(b.prepare(`SELECT status, COUNT(*) n FROM flip_alerts GROUP BY status`).all()).toEqual([{ status: 'sent', n: 6 }]);
  });

  it('a dead owner\'s rows are resent once and the old rows read resent', async () => {
    const dir = tempDir();
    const a = openDb(dir);
    a.prepare(`INSERT INTO flip_alerts (key, at, tier, expected_profit, per_item, units, data_at, status, owner, beat) VALUES ('k0', ?, 'good', ?, 1, 1, 1, 'pending', '999999999:dead', ?)`).run(noon, 12 * G, Date.now());
    const b = openDb(dir);
    const delivered: string[] = [];
    const f = (async (_u: string, init: RequestInit) => { delivered.push(JSON.parse(String(init.body)).content); return ok(); }) as unknown as typeof fetch;
    expect((await flipAlertCycle(b, 'h', flips(), report, { now: noon + 60_000, fetchFn: f })).sent).toBe(6);
    expect((await flipAlertCycle(b, 'h', flips(), report, { now: noon + 120_000, fetchFn: f })).skipped).toBe('nothing new');
    expect(count(delivered)).toBe(6);
    expect(b.prepare(`SELECT status FROM flip_alerts WHERE at = ?`).all(noon)).toEqual([{ status: 'resent' }]);
    const row = reviewAlerts(b, { since: noon - 1, now: noon + 200_000 }).find(r => r.status === 'resent')!;
    expect(row.verdict).toMatch(/resent after a restart/);
    expect(row.verdict).not.toMatch(/FAILED/);
  });

  it('a live owner with no heartbeat for over 5 minutes counts as gone; a fresh heartbeat does not', async () => {
    const dir = tempDir();
    const a = openDb(dir);
    const ins = a.prepare(`INSERT INTO flip_alerts (key, at, tier, expected_profit, per_item, units, data_at, status, owner, beat) VALUES (?, ?, 'good', ?, 1, 1, 1, 'pending', ?, ?)`);
    ins.run('k0', noon, 12 * G, `${process.pid}:other`, Date.now() - 6 * 60_000);
    ins.run('k1', noon, 13 * G, `${process.pid}:other`, Date.now() - 1000);
    const b = openDb(dir);
    const delivered: string[] = [];
    const f = (async (_u: string, init: RequestInit) => { delivered.push(JSON.parse(String(init.body)).content); return ok(); }) as unknown as typeof fetch;
    const r = await flipAlertCycle(b, 'h', flips(), report, { now: noon + 60_000, fetchFn: f });
    expect(r.sent).toBe(5); // k1 is still being sent by its live owner
    expect(b.prepare(`SELECT status FROM flip_alerts WHERE key = 'k1' AND at = ?`).get(noon)).toEqual({ status: 'pending' });
  });
});

describe('Discord timeout', () => {
  it('a hung webhook counts as failed after the timeout and aborts the request', async () => {
    let aborted = false;
    const hung = ((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => { init.signal!.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); })) as unknown as typeof fetch;
    expect(await sendDiscord('h', 'x', hung, 40)).toBe(false);
    expect(aborted).toBe(true);
  });
  it('a fetch that ignores the abort signal still ends at the timeout', async () => {
    expect(await sendDiscord('h', 'x', (() => new Promise<Response>(() => {})) as unknown as typeof fetch, 40)).toBe(false);
  });
  it('a quick answer is unchanged', async () => {
    expect(await sendDiscord('h', 'x', (async () => ok()) as unknown as typeof fetch, 40)).toBe(true);
  });
});

describe('single instance lock', () => {
  it('a second engine does not get the lock; a dead owner\'s lock is taken over; release removes it', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const one = takeInstanceLock(dir);
    expect(one.held).toBe(true);
    expect(takeInstanceLock(dir, process.pid + 1000000).held).toBe(false);
    if (one.held) one.release();
    expect(existsSync(join(dir, 'engine.lock'))).toBe(false);
    writeFileSync(join(dir, 'engine.lock'), '999999999');
    const two = takeInstanceLock(dir);
    expect(two.held).toBe(true);
    if (two.held) two.release();
  });
});
