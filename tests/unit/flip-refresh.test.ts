import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { Engine } from '../../src/engine/engine.ts';
import { buildServer } from '../../src/server/server.ts';
import { fakeBlizzard, tempDir } from '../helpers.ts';

/** The Refresh button's route (brief-refresh-alerts.md): new publish, 304, busy engine, no engine. Fake Blizzard, no Discord. */
function setup() {
  const dir = tempDir();
  let lm = new Date(Date.now() - 5 * 60_000).toUTCString();
  let price = 10;
  const { client, calls } = fakeBlizzard({
    '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 111, name: 'Alliance Auction House' }, { id: 116, name: 'Blackwater Auction House' }] } }),
    '/data/wow/ruleset/2/auctions/111': () => ({ body: { id: 111, auctions: [{ id: 1, item: { id: 4308 }, buyout: 698, quantity: 1, time_left: 'LONG' }] }, lastModified: lm }),
    '/data/wow/ruleset/2/auctions/111/commodities': () => ({ body: { auctions: [{ id: 2, item: { id: 2589 }, quantity: 200, unit_price: price, time_left: 'LONG' }] }, lastModified: lm }),
    '/data/wow/ruleset/2/auctions/116': () => ({ body: { id: 116, auctions: [{ id: 5, item: { id: 4308 }, buyout: 900, quantity: 1, time_left: 'LONG' }] }, lastModified: lm }),
    '/data/wow/ruleset/2/auctions/116/commodities': () => ({ body: { auctions: [{ id: 9, item: { id: 2589 }, quantity: 5, unit_price: 30, time_left: 'LONG' }] }, lastModified: lm }),
    '/data/wow/item/2589': () => ({ body: { id: 2589, name: 'Linen Cloth', quality: { type: 'COMMON' }, sell_price: 13 } }),
    '/data/wow/item/4308': () => ({ body: { id: 4308, name: 'Green Leather Bracers', sell_price: 100, binding: { type: 'ON_EQUIP' } } }),
  });
  const db = openDb(dir, ':memory:');
  const posts: string[] = [];
  const fetchFn = (async (_u: string, init: RequestInit) => { posts.push(String(init.body)); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  const engine = new Engine(client, db, { dataDir: dir, webhookUrl: 'https://discord.example/hook', log: () => {}, fetchFn });
  return { dir, db, engine, client, calls, posts, publish: (p: number) => { price = p; lm = new Date(Date.now() - 60_000).toUTCString(); } };
}

describe('POST /api/flips/refresh', () => {
  it('a new publish is ingested and the flips rerun; a 304 reruns on stored data and says so', async () => {
    const t = setup();
    await t.engine.init();
    t.db.prepare(`UPDATE houses SET pinned = 1 WHERE id IN (111, 116)`).run();
    const app = buildServer({ db: t.db, engine: t.engine, client: t.client, port: 0, dataDir: t.dir });

    const r1 = await app.inject({ method: 'POST', url: '/api/flips/refresh' });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.status).toBe('new');
    expect(b1.publishes).toHaveLength(4);
    expect(b1.run).not.toBeNull();
    expect((t.db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(4);
    const runs1 = (t.db.prepare('SELECT COUNT(*) n FROM flip_runs').get() as { n: number }).n;

    const r2 = (await app.inject({ method: 'POST', url: '/api/flips/refresh' })).json();
    expect(r2.status).toBe('unchanged');
    expect(r2.message).toMatch(/304/);
    expect(r2.publishes).toHaveLength(0);
    expect((t.db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(4);
    expect((t.db.prepare('SELECT COUNT(*) n FROM flip_runs').get() as { n: number }).n).toBeGreaterThan(runs1);

    t.publish(11);
    const r3 = (await app.inject({ method: 'POST', url: '/api/flips/refresh' })).json();
    expect(r3.status).toBe('new');
    expect((t.db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(8);
    // Only Chip's two houses are polled, and the old play alerts stay off by default.
    expect(t.posts).toHaveLength(0);
  });

  it('waits for a running round, then answers 409 when it stays busy', async () => {
    const t = setup();
    await t.engine.init();
    const priv = t.engine as unknown as { running: boolean };
    priv.running = true;
    const busy = buildServer({ db: t.db, engine: t.engine, client: t.client, port: 0, dataDir: t.dir, refreshWaitMs: 50 });
    const r = await busy.inject({ method: 'POST', url: '/api/flips/refresh' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/Busy/);
    const patient = buildServer({ db: t.db, engine: t.engine, client: t.client, port: 0, dataDir: t.dir, refreshWaitMs: 5_000 });
    setTimeout(() => { priv.running = false; }, 300);
    const ok = await patient.inject({ method: 'POST', url: '/api/flips/refresh' });
    expect(ok.statusCode).toBe(200);
    expect(t.engine.busy).toBe(false);
  });

  it('answers 503 with a plain reason when this process has no engine', async () => {
    const t = setup();
    const app = buildServer({ db: t.db, engine: null, client: null, port: 0, dataDir: t.dir });
    const r = await app.inject({ method: 'POST', url: '/api/flips/refresh' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/engine is not running/);
  });
});
