import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/store/db.ts';
import { Engine } from '../../src/engine/engine.ts';
import { buildServer } from '../../src/server/server.ts';
import { flipAlertCycle, flushHeldFlipAlerts } from '../../src/flips/alerts.ts';
import { reviewAlerts } from '../../src/flips/alertReview.ts';
import type { Flip, FlipRunReport } from '../../src/flips/types.ts';
import { fakeBlizzard, tempDir } from '../helpers.ts';

/** Refresh and alerts, round 1 fixes (docs/handoff/brief-refresh-alerts-r1.md). Never a real Discord call: fetch is mocked. */
const noon = Date.parse('2026-11-18T19:00:00Z'); // noon in Denver, outside the default quiet hours
const G = 10_000, HOUR = 3600_000;
const db = (): DB => openDb(tempDir(), ':memory:');

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
const report: Pick<FlipRunReport, 'complete' | 'dataAt'> = { complete: true, dataAt: noon - 10 * 60_000 };

/** A Discord that takes its time, like the real one while the other path blocks the event loop. */
function slowDiscord(ms: number, status = 204) {
  const sent: string[] = [];
  const fetchFn = (async (_u: string, init: RequestInit) => {
    await new Promise(r => setTimeout(r, ms));
    sent.push(JSON.parse(String(init.body)).content);
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

describe('finding A: an alert is claimed before it is sent', () => {
  it('two overlapping runs with a slow Discord send each flip once', async () => {
    const d = db();
    const { sent, fetchFn } = slowDiscord(300);
    const flips = Array.from({ length: 15 }, (_, i) => flip(12 + i, `k${i}`));
    const [a, b] = await Promise.all([
      flipAlertCycle(d, 'h', flips, report, { now: noon, fetchFn }),
      flipAlertCycle(d, 'h', flips, report, { now: noon + 2, fetchFn }),
    ]);
    expect(a.sent + b.sent).toBe(15);
    expect([a.skipped, b.skipped]).toContain('nothing new');
    expect(sent.join('\n').match(/\*\*(AMAZING|Good)\*\*/g)).toHaveLength(15);
    expect(d.prepare('SELECT status, COUNT(*) n FROM flip_alerts GROUP BY status').all()).toEqual([{ status: 'sent', n: 15 }]);
  });
  it('a pending claim from a dead process is resent at once, not after a stale window (see alert-crash.test.ts)', async () => {
    const d = db();
    d.prepare(`INSERT INTO flip_alerts (key, at, tier, expected_profit, per_item, units, data_at, status) VALUES ('k', ?, 'amazing', ?, 1, 1, 1, 'pending')`).run(noon, 25 * G);
    const { sent, fetchFn } = slowDiscord(1);
    expect((await flipAlertCycle(d, 'h', [flip(25, 'k')], report, { now: noon + 60_000, fetchFn })).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it('alerts held in quiet hours stay held when the post after quiet hours fails', async () => {
    const d = db();
    const night = Date.parse('2026-11-19T08:00:00Z'), morning = Date.parse('2026-11-19T14:05:00Z');
    const f = { ...flip(25, 'q'), dataAt: night - 5 * 60_000 };
    expect((await flipAlertCycle(d, 'h', [f], { complete: true, dataAt: night - 5 * 60_000 }, { now: night })).skipped).toBe('quiet hours');
    d.prepare(`INSERT INTO flip_runs (at, data_at, ms, complete, report) VALUES (?, ?, 1, 1, '{}')`).run(morning - 60_000, morning - 5 * 60_000);
    d.prepare(`INSERT INTO flips (key, kind, family, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at) VALUES ('q', 'craft', 'craft_auction', 2996, 'live', 1, 'low', ?, 1, 1, ?)`)
      .run(JSON.stringify({ ...f, dataAt: morning - 5 * 60_000 }), morning - 5 * 60_000);
    const down = slowDiscord(1, 500);
    expect((await flushHeldFlipAlerts(d, 'h', { now: morning, fetchFn: down.fetchFn }))!.skipped).toBe('discord failed');
    const up = slowDiscord(1);
    expect((await flushHeldFlipAlerts(d, 'h', { now: morning + 2 * 60_000, fetchFn: up.fetchFn }))!.sent).toBe(1);
    expect(up.sent).toHaveLength(1);
  });
});

function setup(opts: { down?: () => boolean } = {}) {
  const dir = tempDir();
  const lm = new Date(Date.now() - 5 * 60_000).toUTCString();
  const fail = () => ({ body: { code: 403 }, status: 403 });
  const { client } = fakeBlizzard({
    '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 111, name: 'Alliance Auction House' }, { id: 116, name: 'Blackwater Auction House' }] } }),
    '/data/wow/ruleset/2/auctions/111': () => opts.down?.() ? fail() : ({ body: { id: 111, auctions: [{ id: 1, item: { id: 4308 }, buyout: 698, quantity: 1, time_left: 'LONG' }] }, lastModified: lm }),
    '/data/wow/ruleset/2/auctions/111/commodities': () => opts.down?.() ? fail() : ({ body: { auctions: [{ id: 2, item: { id: 2589 }, quantity: 200, unit_price: 10, time_left: 'LONG' }] }, lastModified: lm }),
    '/data/wow/ruleset/2/auctions/116': () => opts.down?.() ? fail() : ({ body: { id: 116, auctions: [{ id: 5, item: { id: 4308 }, buyout: 900, quantity: 1, time_left: 'LONG' }] }, lastModified: lm }),
    '/data/wow/ruleset/2/auctions/116/commodities': () => opts.down?.() ? fail() : ({ body: { auctions: [{ id: 9, item: { id: 2589 }, quantity: 5, unit_price: 30, time_left: 'LONG' }] }, lastModified: lm }),
    '/data/wow/item/2589': () => ({ body: { id: 2589, name: 'Linen Cloth', quality: { type: 'COMMON' }, sell_price: 13 } }),
    '/data/wow/item/4308': () => ({ body: { id: 4308, name: 'Green Leather Bracers', sell_price: 100, binding: { type: 'ON_EQUIP' } } }),
  });
  const d = openDb(dir, ':memory:');
  const { fetchFn } = slowDiscord(1);
  const engine = new Engine(client, d, { dataDir: dir, webhookUrl: 'https://discord.example/hook', log: () => {}, fetchFn });
  return { dir, db: d, engine, client };
}

describe('finding A: every detect path takes the engine lock', () => {
  it('startup detect, house pin and refresh started together never overlap', async () => {
    const t = setup();
    await t.engine.init();
    t.db.prepare(`UPDATE houses SET pinned = 1 WHERE id IN (111, 116)`).run();
    // Count how many flip and alert steps run at once, with a slow step inside, like a slow Discord post.
    const priv = t.engine as unknown as { flipsAndAlerts: (now?: number) => Promise<unknown> };
    const real = priv.flipsAndAlerts.bind(t.engine);
    let inside = 0, most = 0, calls = 0;
    priv.flipsAndAlerts = async (now?: number) => {
      inside++; calls++; most = Math.max(most, inside);
      try { await new Promise(r => setTimeout(r, 150)); return await real(now); } finally { inside--; }
    };
    const app = buildServer({ db: t.db, engine: t.engine, client: t.client, port: 0, dataDir: t.dir, refreshWaitMs: 10_000 });
    const results = await Promise.all([
      t.engine.detect(),
      app.inject({ method: 'POST', url: '/api/houses/pin', payload: { alliance: 111 } }),
      app.inject({ method: 'POST', url: '/api/flips/refresh' }),
      t.engine.detect(),
    ]);
    expect(calls).toBe(4);
    expect(most).toBe(1);
    expect((results[2] as { statusCode: number }).statusCode).toBe(200);
    expect(t.engine.busy).toBe(false);
  });
  it('a detect waits for a running round', async () => {
    const t = setup();
    await t.engine.init();
    const priv = t.engine as unknown as { running: boolean };
    priv.running = true;
    let done = false;
    const p = t.engine.detect().then(() => { done = true; });
    await new Promise(r => setTimeout(r, 300));
    expect(done).toBe(false);
    priv.running = false;
    await p;
    expect(done).toBe(true);
  });
});

describe('finding D: a failed poll is never read as a 304', () => {
  it('no house answered: status failed, the errors by house, no rerun', async () => {
    let down = false;
    const t = setup({ down: () => down });
    await t.engine.init();
    t.db.prepare(`UPDATE houses SET pinned = 1 WHERE id IN (111, 116)`).run();
    const app = buildServer({ db: t.db, engine: t.engine, client: t.client, port: 0, dataDir: t.dir });
    expect((await app.inject({ method: 'POST', url: '/api/flips/refresh' })).json().status).toBe('new');
    const runs = (t.db.prepare('SELECT COUNT(*) n FROM flip_runs').get() as { n: number }).n;
    down = true;
    const b = (await app.inject({ method: 'POST', url: '/api/flips/refresh' })).json();
    expect(b.status).toBe('failed');
    expect(b.errors.length).toBe(4);
    expect(b.message).toMatch(/^Blizzard did not answer for house 111: .*403.*Blizzard did not answer for house 116: /);
    expect(b.message).not.toMatch(/304/);
    expect((t.db.prepare('SELECT COUNT(*) n FROM flip_runs').get() as { n: number }).n).toBe(runs);
  });
});

describe('finding C: alert review counts publishes, not reruns', () => {
  it('reruns on one publish count once; too few publishes is said plainly; the item name is shown', () => {
    const d = db();
    d.prepare(`INSERT INTO items (id, name, status, fetched_at) VALUES (2996, 'Bolt of Linen Cloth', 200, 1)`).run();
    d.prepare(`INSERT INTO flip_alerts (key, at, tier, expected_profit, per_item, units, data_at, item_id, house_id, claim_price, status) VALUES ('r', ?, 'good', 1, 1, 20, ?, 2996, 111, 1000, 'sent')`)
      .run(noon, noon - 10 * 60_000);
    d.prepare(`INSERT INTO flip_alerts (key, at, tier, expected_profit, per_item, units, data_at, status) VALUES ('f', ?, 'good', 1, 1, 20, ?, 'failed')`).run(noon, noon - 10 * 60_000);
    const run = (at: number, dataAt: number, keys: string[]) => {
      d.prepare(`INSERT INTO flip_runs (at, data_at, ms, complete, report) VALUES (?, ?, 1, 1, '{}')`).run(at, dataAt);
      for (const k of keys) d.prepare('INSERT OR REPLACE INTO flip_history (at, key, expected_profit, per_item, units) VALUES (?, ?, 1, 1, 1)').run(dataAt, k);
    };
    // the alert's own publish rerun three times (Refresh clicks), then one new publish rerun twice
    for (const m of [1, 2, 3]) run(noon + m * 60_000, noon - 10 * 60_000, ['r']);
    run(noon + HOUR, noon + HOUR - 10 * 60_000, ['r']);
    run(noon + HOUR + 60_000, noon + HOUR - 10 * 60_000, ['r']);
    const rows = reviewAlerts(d, { now: noon + 2 * HOUR, since: noon - HOUR });
    expect(rows).toHaveLength(2); // the failed claim is listed too, with its status
    expect(rows.find(r => r.status === "sent")).toMatchObject({ key: 'r', name: 'Bolt of Linen Cloth', liveNext: 1, publishesAfter: 1, tooSoon: true });
    expect(rows.find(r => r.status === 'sent')!.verdict).toMatch(/^live at 1 of 1 publish so far; only 1 publish since, too few to judge yet \(needs 3\)/);
    run(noon + 2 * HOUR, noon + 2 * HOUR - 10 * 60_000, []);
    run(noon + 3 * HOUR, noon + 3 * HOUR - 10 * 60_000, ['r']);
    expect(reviewAlerts(d, { now: noon + 4 * HOUR, since: noon - HOUR }).find(r => r.status === 'sent')).toMatchObject({ liveNext: 2, publishesAfter: 3, tooSoon: false });
  });
});
