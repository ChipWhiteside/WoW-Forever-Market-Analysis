import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/store/db.ts';
import { flipAlertCycle } from '../../src/flips/alerts.ts';
import { reviewAlerts } from '../../src/flips/alertReview.ts';
import type { Flip, FlipRunReport } from '../../src/flips/types.ts';
import { tempDir } from '../helpers.ts';

/** Crash mid send (refresh round 2). Fetch is mocked. A restart is a second DB handle on the same file: it has an empty in flight set. */
const noon = Date.parse('2026-11-18T19:00:00Z');
const G = 10_000;
const report: Pick<FlipRunReport, 'complete' | 'dataAt'> = { complete: true, dataAt: noon - 10 * 60_000 };

function flip(gold: number, key: string): Flip {
  const ep = Math.round(gold * G);
  const risk = { atStake: 5 * G, badCaseLoss: G, daysToSell: 0.5, level: 'low' as const, drivers: [] };
  const best = { label: 'best' as const, units: 20, cost: 5 * G, expectedSold: 18, expectedProfit: ep, minutes: 5, goldPerHour: null, risk };
  return {
    key, kind: 'craft', family: 'craft_auction', itemId: 2996, name: 'Bolt of Linen Cloth', recipeId: 2963, sellHouseId: 111,
    buy: [{ kind: 'auction', itemId: 2589, name: 'Linen Cloth', units: 40, unitPrice: 10, who: 'Alliance auction house', houseId: 111, places: [] }],
    sell: { kind: 'auction', itemId: 2996, name: 'Bolt of Linen Cloth', units: 20, unitPrice: 900, who: 'Alliance auction house', houseId: 111, places: [] },
    perItem: Math.round(ep / 20), best, options: [best],
    sellQuote: { houseId: 111, claimPrice: 1000, netEach: 950, undercutPrice: 990, listed: 1000, basis: 'sold', ahead: 0, salesPerDayLow: 30, salesPerDayMid: 40,
      hoursWatched: 24, newPerHour: 0, sweepHigh: null, low3d: 900, cv: 0.05, strength: 82, strengthParts: [], gates: [], rising: false },
    repeatable: true, opening: 'new', openHours72: 3, setup: null, shares: [], afterShared: { units: 20, expectedProfit: ep }, notes: [], dataAt: noon - 10 * 60_000,
  };
}
const flips = () => Array.from({ length: 15 }, (_, i) => flip(12 + i, `k${i}`));
const status = (d: DB) => d.prepare('SELECT status, COUNT(*) n FROM flip_alerts GROUP BY status').all() as Array<{ status: string; n: number }>;
const blocks = (xs: string[]) => xs.join('\n').match(/\*\*(AMAZING|Good)\*\*/g)?.length ?? 0;

describe('crash mid send', () => {
  it('rows are marked sent after each post, before the next post goes out', async () => {
    const d = openDb(tempDir(), ':memory:');
    const seen: Array<Array<{ status: string; n: number }>> = [];
    const fetchFn = (async () => { seen.push(status(d)); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    await flipAlertCycle(d, 'h', flips(), report, { now: noon, fetchFn });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[1]!.find(r => r.status === 'sent')!.n).toBeGreaterThan(0);
  });

  it('a failed post stops the run: one wait per run on a hung webhook, the rest marked failed and retried next run', async () => {
    const d = openDb(tempDir(), ':memory:');
    let calls = 0;
    const down = (async () => { calls++; return new Response(null, { status: 500 }); }) as unknown as typeof fetch;
    await flipAlertCycle(d, 'h', flips(), report, { now: noon, fetchFn: down });
    expect(calls).toBe(1);
    expect(status(d)).toEqual([{ status: 'failed', n: 15 }]);
    let sentPosts = 0;
    const up = (async () => { sentPosts++; return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    await flipAlertCycle(d, 'h', flips(), report, { now: noon + 3600_000, fetchFn: up });
    expect(sentPosts).toBeGreaterThan(1);
    expect((d.prepare(`SELECT COUNT(DISTINCT key) n FROM flip_alerts WHERE status = 'sent'`).get() as { n: number }).n).toBe(15);
  });

  it('after a kill during post 2, the restart resends promptly; only the in flight post doubles', async () => {
    const dir = tempDir();
    const d1 = openDb(dir);
    const delivered: string[] = [];
    let n = 0;
    // Post 1 is answered. Post 2 reaches Discord, then the process dies before the answer (the fetch never returns).
    const dying = (async (_u: string, init: RequestInit) => {
      delivered.push(JSON.parse(String(init.body)).content);
      if (++n === 2) return new Promise<Response>(() => {});
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    void flipAlertCycle(d1, 'h', flips(), report, { now: noon, fetchFn: dying });
    await new Promise(r => setTimeout(r, 50));
    expect(delivered).toHaveLength(2);
    const before = status(d1);
    expect(before.find(r => r.status === 'sent')!.n).toBeGreaterThan(0); // post 1 already marked
    expect(before.find(r => r.status === 'pending')!.n).toBeGreaterThan(0);
    // The first process dies: its pid is gone (the owner rule, tests/unit/alert-owner.test.ts).
    d1.prepare(`UPDATE flip_alerts SET owner = '999999999:dead'`).run();
    const d2 = openDb(dir);
    const after: string[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { after.push(JSON.parse(String(init.body)).content); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    const r = await flipAlertCycle(d2, 'h', flips(), report, { now: noon + 60_000, fetchFn });
    expect(r.skipped).toBeNull();
    const post1 = blocks(delivered.slice(0, 1)), post2 = blocks(delivered.slice(1, 2));
    // Nothing lost or late: the restart sends exactly what post 1 did not confirm. Only post 2 (in flight) is delivered twice.
    expect(r.sent).toBe(15 - post1);
    expect(blocks(after)).toBe(15 - post1);
    expect(post1 + blocks(after)).toBe(15 + 0);
    expect(post2).toBeGreaterThan(0);
    expect(d2.prepare(`SELECT COUNT(*) n FROM flip_alerts WHERE status = 'pending'`).get()).toEqual({ n: 0 });
    expect((await flipAlertCycle(d2, 'h', flips(), report, { now: noon + 120_000, fetchFn })).skipped).toBe('nothing new');
  });

  it('a pending row whose flip no longer qualifies is closed as failed, not left pending', async () => {
    const d = openDb(tempDir(), ':memory:');
    d.prepare(`INSERT INTO flip_alerts (key, at, tier, expected_profit, per_item, units, data_at, status) VALUES ('gone', ?, 'good', ?, 1, 1, 1, 'pending')`).run(noon, 15 * G);
    const fetchFn = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await flipAlertCycle(d, 'h', [flip(25, 'k')], report, { now: noon + 1000, fetchFn });
    expect(d.prepare(`SELECT status FROM flip_alerts WHERE key = 'gone'`).get()).toEqual({ status: 'failed' });
  });

  it('alert review lists pending and failed rows', () => {
    const d = openDb(tempDir(), ':memory:');
    const ins = d.prepare(`INSERT INTO flip_alerts (key, at, tier, expected_profit, per_item, units, data_at, status) VALUES (?, ?, 'good', 1, 1, 1, 1, ?)`);
    ins.run('a', noon, 'pending'); ins.run('b', noon + 1, 'failed'); ins.run('c', noon + 2, 'sent');
    const rows = reviewAlerts(d, { since: noon - 1, now: noon + 10 });
    expect(rows.map(r => r.status).sort()).toEqual(['failed', 'pending', 'sent']);
    expect(rows.find(r => r.status === 'pending')!.verdict).toMatch(/PENDING/);
  });
});
