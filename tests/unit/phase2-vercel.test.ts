/**
 * The Vercel handler (src/cloud/vercelHandler.ts) over a real node http server, against the fake GitHub API sealed
 * with a test DATA_KEY: GETs come from the downloaded database and the published JSON, writes become inbox events
 * after a rolled back try, Refresh dispatches or joins a run, and login gates all of it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb } from '../../src/store/db.ts';
import { makeHandler } from '../../src/cloud/vercelHandler.ts';
import { GitHubStore } from '../../src/cloud/githubStore.ts';
import { GitHub } from '../../src/cloud/githubApi.ts';
import { SealedStore } from '../../src/cloud/crypto.ts';
import { pushDb, putJson, RESULTS_KEY, LEDGER_KEY, DB_PREFIX } from '../../src/cloud/layout.ts';
import { readEvents, ledgerFile } from '../../src/cloud/inbox.ts';
import { COOKIE } from '../../src/server/auth.ts';
import { tempDir } from '../helpers.ts';
import { fakeGitHub, REPO } from '../fakeGitHub.ts';

const KEY = randomBytes(32);
const noSleep = async () => {};

/** A cloud as the hourly run leaves it: one flip, one setting, one "I did this" by Chip, all published. */
async function setup(env: Record<string, string> = {}, opts: { publish?: boolean } = {}) {
  const f = fakeGitHub();
  const gh = new GitHub({ token: f.token, repo: REPO, fetchFn: f.fetchFn, sleep: noSleep });
  const store = new SealedStore(new GitHubStore(gh, { sleep: noSleep }), KEY);
  const dir = tempDir();
  const db = openDb(dir);
  const detail = { key: 'f1', name: 'Bandage', itemId: 100, perItem: 300, best: { units: 5, cost: 1000, expectedProfit: 1500 }, options: [] };
  db.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at) VALUES ('f1', 'craft', 'craft_auction', 1, 100, 'live', 1500, 'low', ?, 1, 1, 1)`).run(JSON.stringify(detail));
  db.prepare(`INSERT INTO settings (key, value) VALUES ('alert_good_gold', '10')`).run();
  db.prepare(`INSERT INTO user_actions (action, flip_key, username, at, units, expected_cost, expected_profit, item_id, name, kind, house_id) VALUES ('did', 'f1', 'Chip', 1, 5, 1000, 1500, 100, 'Bandage', 'craft', 1)`).run();
  if (opts.publish !== false) {
    await putJson(store, RESULTS_KEY, JSON.stringify({ flips: [{ key: 'f1', detail }], run: null, heldBack: [], fromResults: true }));
    await putJson(store, LEDGER_KEY, ledgerFile(db));
  }
  db.close();
  if (opts.publish !== false) await pushDb([{ store, keep: 2 }], dir);
  const go = await serve(makeHandler({ store, gh, env, dir: tempDir(), dispatch: { findTries: 2, findEveryMs: 1 } }));
  return { f, store, go };
}

let server: Server | null = null;
afterEach(() => new Promise<void>(r => { if (server) server.close(() => r()); else r(); server = null; }));
async function serve(h: ReturnType<typeof makeHandler>) {
  server = createServer((req, res) => { void h(req, res); });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
}
const postJson = (body: unknown, headers: Record<string, string> = {}, method = 'POST') => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const downloads = (f: ReturnType<typeof fakeGitHub>) => f.calls.filter(c => /^GET .*\/releases\/assets\/\d+$/.test(c)).length;

describe('Vercel handler on GitHub storage', () => {
  it('GET /api/flips is results.json; other GETs read the downloaded database, fetched once per asset', async () => {
    const { f, store, go } = await setup();
    const a = await (await go('/api/flips')).json();
    expect(a.fromResults).toBe(true);
    expect((await (await go('/api/settings')).json()).alert_good_gold).toBe('10');
    expect((await (await go('/api/flips?gone=1')).json()).flips.map((x: { key: string }) => x.key)).toEqual(['f1']);
    const n = downloads(f);
    await go('/api/settings'); await go('/api/flips');
    expect(downloads(f)).toBe(n); // cached by asset id
    // The hourly run publishes a new database: the next GET downloads it.
    const dir = tempDir(); openDb(dir).close();
    await pushDb([{ store, keep: 2 }], dir, { at: Date.now() + 1000 });
    expect(await (await go('/api/settings')).json()).toEqual({});
    expect(downloads(f)).toBe(n + 1);
  });

  it('before the first cycle: the empty schema, and the ledger from the database', async () => {
    const { go } = await setup({}, { publish: false });
    expect(await (await go('/api/flips')).json()).toMatchObject({ flips: [], run: null });
    expect((await (await go('/api/ledger')).json()).people).toEqual([]);
  });

  it('a write is tried, rolled back and saved as a sealed inbox event; the database never changes', async () => {
    const { f, store, go } = await setup();
    const r = await go('/api/flips/f1/did', postJson({ units: 2 }));
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ expectedCost: 400, expectedProfit: 600, pending: true, message: 'Saved, counts at the next update.' });
    const events = await readEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]!.key).toMatch(/^events\/\d{13}-[0-9a-f]{12}\.json$/);
    expect(events[0]!.ev).toMatchObject({ user: 'local', method: 'POST', url: '/api/flips/f1/did', body: '{"units":2}' });
    expect(f.assets().filter(a => a.name.startsWith(DB_PREFIX))).toHaveLength(1);
    // The rolled back try left nothing behind on the site's copy.
    expect((await (await go('/api/flips?gone=1')).json()).flips).toHaveLength(1);
    expect((await (await go('/api/ledger')).json()).people[0]).toMatchObject({ username: 'Chip', flipsDone: 1 });
  });

  it('a refused write answers as the route does and saves nothing', async () => {
    const { store, go } = await setup();
    expect((await go('/api/flips/nope/did', postJson({ units: 2 }))).status).toBe(404);
    expect((await go('/api/flips/f1/did', postJson({ units: 0 }))).status).toBe(400);
    expect((await go('/api/ledger/1/sold', postJson({ units: 1, received: 5 }))).status).toBe(403); // Chip's, not local's
    expect(await readEvents(store)).toEqual([]);
  });

  it('the ledger shows saved events as pending until the cycle lists them as applied', async () => {
    const { go } = await setup({ SITE_PASSWORD: 'pw', SESSION_SECRET: 's' });
    const login = await go('/api/login', postJson({ username: 'Chip', password: 'pw' }));
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await go('/api/flips/f1/did', postJson({ units: 3 }, { cookie }))).status).toBe(202);
    expect((await go('/api/ledger/1/sold', postJson({ units: 2, received: 4000 }, { cookie }))).status).toBe(202);
    const l = await (await go('/api/ledger', { headers: { cookie } })).json();
    expect(l.people[0]).toMatchObject({ username: 'Chip', flipsDone: 1 }); // the totals count only applied rows
    expect(l.pending.map((p: Record<string, unknown>) => [p.action, p.username, p.units, p.name])).toEqual([['did', 'Chip', 3, 'Bandage'], ['sold', 'Chip', 2, 'Bandage']]);
  });

  it('saved settings show at once on GET /api/settings, laid over the published ones', async () => {
    const { go } = await setup();
    expect((await go('/api/settings', postJson({ alert_good_gold: 12, alert_amazing_gold: 30 }, {}, 'PUT'))).status).toBe(202);
    expect(await (await go('/api/settings')).json()).toEqual({ alert_good_gold: '12', alert_amazing_gold: '30' });
  });

  it('Refresh dispatches the collect workflow and answers 202; a second press joins the same run; status follows it', async () => {
    const { f, go } = await setup();
    const r = await go('/api/flips/refresh', { method: 'POST' });
    expect(r.status).toBe(202);
    const a = await r.json();
    expect(a).toMatchObject({ status: 'running', joined: false, state: 'queued', message: 'Running on GitHub, usually 1 to 2 minutes.' });
    expect(f.calls.filter(c => c.includes('/dispatches'))).toHaveLength(1);
    const b = await (await go('/api/flips/refresh', { method: 'POST' })).json();
    expect(b).toMatchObject({ joined: true, runId: a.runId });
    expect(f.calls.filter(c => c.includes('/dispatches'))).toHaveLength(1);
    f.runs.find(x => x.id === a.runId)!.status = 'completed';
    expect(await (await go(`/api/flips/refresh/status?run=${a.runId}`)).json()).toMatchObject({ state: 'completed', conclusion: null });
  });

  it('login is required for every route but login and me, Refresh included', async () => {
    const { f, store, go } = await setup({ SITE_PASSWORD: 'pw', SESSION_SECRET: 's' });
    for (const [path, init] of [['/api/flips', undefined], ['/api/ledger', undefined], ['/api/settings', undefined], ['/api/flips/refresh/status', undefined],
      ['/api/flips/refresh', { method: 'POST' }], ['/api/flips/f1/did', postJson({ units: 1 })]] as const) {
      expect((await go(path, init)).status, path).toBe(401);
    }
    expect(f.calls.some(c => c.includes('/dispatches'))).toBe(false);
    expect(await readEvents(store)).toEqual([]);
    expect((await (await go('/api/me')).json()).authRequired).toBe(true);
    expect((await go('/api/login', postJson({ username: 'Chip', password: 'bad' }))).status).toBe(401);
    const login = await go('/api/login', postJson({ username: 'Chip', password: 'pw' }, { 'x-forwarded-proto': 'https' }));
    expect(login.headers.get('set-cookie')).toMatch(new RegExp(`^${COOKIE}=.*HttpOnly.*Secure`));
  });
});
