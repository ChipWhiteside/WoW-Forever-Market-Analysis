import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { makeHandler } from '../../src/cloud/vercelHandler.ts';
import { getDb, DB_KEY, DB_LOCK } from '../../src/cloud/dbCache.ts';
import { makeAuth, COOKIE } from '../../src/server/auth.ts';
import { MemoryStore } from '../memoryStore.ts';
import { tempDir } from '../helpers.ts';

/** A real wowf.db with one flip and one setting, as the cloud run would leave it in storage. */
function seed(store: MemoryStore) {
  const dir = tempDir();
  const db = openDb(dir);
  const detail = { key: 'f1', name: 'Bandage', itemId: 100, perItem: 300, best: { units: 5, cost: 1000, expectedProfit: 1500 }, options: [] };
  db.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at) VALUES ('f1', 'craft', 'craft_auction', 1, 100, 'live', 1500, 'low', ?, 1, 1, 1)`).run(JSON.stringify(detail));
  db.prepare(`INSERT INTO settings (key, value) VALUES ('alert_good_gold', '10')`).run();
  db.close();
  return store.put(DB_KEY, new Uint8Array(readFileSync(join(dir, 'wowf.db'))));
}

let server: Server | null = null;
afterEach(() => new Promise<void>(r => { if (server) server.close(() => r()); else r(); server = null; }));
async function serve(h: ReturnType<typeof makeHandler>) {
  server = createServer((req, res) => { void h(req, res); });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
}
const postJson = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('Vercel handler over node http with an in memory store', () => {
  it('GET /api/flips reads the cached database: downloads once, again only when the ETag changes', async () => {
    const store = new MemoryStore();
    await seed(store);
    const go = await serve(makeHandler({ store, env: {}, dir: tempDir() }));
    const a = await go('/api/flips');
    expect(a.status).toBe(200);
    expect((await a.json()).flips.map((f: any) => f.key)).toEqual(['f1']);
    await go('/api/flips');
    await go('/api/settings');
    expect(store.calls.get).toBe(1);
    expect(store.calls.head).toBe(3);
    await seed(store); // same content, same ETag
    await go('/api/flips');
    expect(store.calls.get).toBe(1);
    // The hourly run uploads a different database: the next GET downloads it.
    const dir = tempDir(); const db = openDb(dir); db.close();
    await store.put(DB_KEY, new Uint8Array(readFileSync(join(dir, 'wowf.db'))));
    expect((await (await go('/api/flips')).json()).flips).toEqual([]);
    expect(store.calls.get).toBe(2);
  });

  it('the read copy is opened read only', async () => {
    const store = new MemoryStore();
    await seed(store);
    const { db } = await getDb(store, { dir: tempDir() });
    expect(() => db.prepare(`INSERT INTO settings (key, value) VALUES ('x', 'y')`).run()).toThrow(/readonly/i);
  });

  it('a write takes the lock, applies on a fresh copy, uploads and releases; the next GET sees it', async () => {
    const store = new MemoryStore();
    await seed(store);
    const go = await serve(makeHandler({ store, env: {}, dir: tempDir() }));
    await go('/api/ledger');
    const puts = store.calls.put;
    const r = await go('/api/flips/f1/did', postJson({ units: 2 }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ expectedCost: 400, expectedProfit: 600 });
    expect(store.calls.put).toBe(puts + 1);
    expect(store.locks.size).toBe(0);
    const l = await (await go('/api/ledger')).json();
    expect(l.people[0]).toMatchObject({ username: 'local', flipsDone: 1, spent: 400 });
    // A refused write uploads nothing.
    expect((await go('/api/flips/nope/did', postJson({ units: 2 }))).status).toBe(404);
    expect(store.calls.put).toBe(puts + 1);
    expect(store.locks.size).toBe(0);
  });

  it('a held lock answers 409 for writes and Refresh, and reads still work', async () => {
    const store = new MemoryStore();
    await seed(store);
    const release = await store.lock(DB_LOCK, 60_000, 'hourly-run');
    let cycles = 0;
    const go = await serve(makeHandler({ store, env: {}, dir: tempDir(), runCycle: async s => { cycles++; if (!(await s.lock(DB_LOCK, 60_000, 'refresh'))) throw new Error('lock held by the hourly run'); } }));
    const w = await go('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alert_good_gold: 12 }) });
    expect(w.status).toBe(409);
    expect((await w.json()).error).toMatch(/Busy/);
    expect((await go('/api/flips/refresh', { method: 'POST' })).status).toBe(409);
    expect(cycles).toBe(1);
    expect((await go('/api/flips')).status).toBe(200);
    // Login needs no lock, so people can sign in during the hourly run.
    expect((await go('/api/login', postJson({ username: 'Chip', password: '' }))).status).toBe(200);
    await release!();
    expect((await go('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alert_good_gold: 12 }) })).status).toBe(200);
    expect((await (await go('/api/settings')).json()).alert_good_gold).toBe('12');
  });

  it('Refresh runs the cloud cycle and answers with the newest run; login gates it and the cookie passes through', async () => {
    const store = new MemoryStore();
    await seed(store);
    const env = { SITE_PASSWORD: 'pw', SESSION_SECRET: 's' };
    const go = await serve(makeHandler({ store, env, dir: tempDir(), runCycle: async () => ({ status: 'new', message: 'New data.' }) }));
    expect((await go('/api/flips')).status).toBe(401);
    expect((await go('/api/flips/refresh', { method: 'POST' })).status).toBe(401);
    const login = await go('/api/login', postJson({ username: 'Chip', password: 'pw' }, { 'x-forwarded-proto': 'https' }));
    const set = login.headers.get('set-cookie')!;
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    const cookie = set.split(';')[0]!;
    expect(cookie).toBe(`${COOKIE}=${encodeURIComponent(cookie.slice(COOKIE.length + 1))}`);
    expect(makeAuth({ password: 'pw', secret: 's' }).userOf(cookie)).toBe('Chip');
    const r = await go('/api/flips/refresh', { method: 'POST', headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'new', message: 'New data.', run: null });
    const did = await go('/api/flips/f1/did', postJson({ units: 5 }, { cookie }));
    expect(did.status).toBe(200);
    expect((await (await go('/api/ledger', { headers: { cookie } })).json()).people[0].username).toBe('Chip');
  });

  it('an empty store serves the empty schema until the first cloud run', async () => {
    const go = await serve(makeHandler({ store: new MemoryStore(), env: {}, dir: tempDir() }));
    const r = await go('/api/flips');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ flips: [], run: null });
  });
});
