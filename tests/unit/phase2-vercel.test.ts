/**
 * The Vercel handler (src/cloud/vercelHandler.ts) over a real node http server, against the fake GitHub API sealed
 * with a test DATA_KEY: GETs come from the downloaded database and the published JSON, writes become inbox events
 * after a rolled back try, Refresh dispatches or joins a run, and login gates all of it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb, type DB } from '../../src/store/db.ts';
import { makeHandler } from '../../src/cloud/vercelHandler.ts';
import { GitHubStore } from '../../src/cloud/githubStore.ts';
import { GitHub } from '../../src/cloud/githubApi.ts';
import { SealedStore } from '../../src/cloud/crypto.ts';
import { pushDb, pullDb, newestDb, putJson, RESULTS_KEY, LEDGER_KEY, DB_PREFIX } from '../../src/cloud/layout.ts';
import { readEvents, ledgerFile, applyEvents } from '../../src/cloud/inbox.ts';
import { useSiteDb } from '../../src/cloud/dbCache.ts';
import { LocalStore } from '../../src/cloud/localStore.ts';
import { existsSync } from 'node:fs';
import { COOKIE } from '../../src/server/auth.ts';
import { tempDir } from '../helpers.ts';
import { fakeGitHub, REPO } from '../fakeGitHub.ts';

const KEY = randomBytes(32);
const noSleep = async () => {};

/** A cloud as the hourly run leaves it: one flip, one setting, one "I did this" by Chip, all published. */
async function setup(env: Record<string, string> = {}, opts: { publish?: boolean; now?: () => number; seed?: (db: DB) => void } = {}) {
  const f = fakeGitHub();
  const gh = new GitHub({ token: f.token, repo: REPO, fetchFn: f.fetchFn, sleep: noSleep });
  const store = new SealedStore(new GitHubStore(gh, { sleep: noSleep }), KEY);
  const dir = tempDir();
  const db = openDb(dir);
  const detail = { key: 'f1', name: 'Bandage', itemId: 100, perItem: 300, best: { units: 5, cost: 1000, expectedProfit: 1500 }, options: [] };
  db.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at) VALUES ('f1', 'craft', 'craft_auction', 1, 100, 'live', 1500, 'low', ?, 1, 1, 1)`).run(JSON.stringify(detail));
  db.prepare(`INSERT INTO settings (key, value) VALUES ('alert_good_gold', '10')`).run();
  db.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES (111, 'Alliance Auction House', 'alliance', 0.05, 1, 1), (116, 'Blackwater Auction House', 'blackwater', 0.15, 1, 0)`);
  db.prepare(`INSERT INTO user_actions (action, flip_key, username, at, units, expected_cost, expected_profit, item_id, name, kind, house_id) VALUES ('did', 'f1', 'Chip', 1, 5, 1000, 1500, 100, 'Bandage', 'craft', 1)`).run();
  opts.seed?.(db);
  if (opts.publish !== false) {
    await putJson(store, RESULTS_KEY, JSON.stringify({ flips: [{ key: 'f1', detail }], run: null, heldBack: [], fromResults: true }));
    await putJson(store, LEDGER_KEY, ledgerFile(db));
  }
  db.close();
  if (opts.publish !== false) await pushDb([{ store, keep: 2 }], dir);
  const go = await serve(makeHandler({ store, gh, env, dir: tempDir(), dispatch: { findTries: 2, findEveryMs: 1 }, now: opts.now }));
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

  it('a saved house pin answers the route own list and shows on GET /api/houses before the next update', async () => {
    const { go } = await setup();
    const r = await go('/api/houses/pin', postJson({ blackwater: 116 }));
    expect(r.status).toBe(202);
    expect(r.headers.get('x-wowf-pending')).toMatch(/^events\//);
    const list = await r.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.find((h: { id: number }) => h.id === 116).pinned).toBe(1);
    expect((await (await go('/api/houses')).json()).find((h: { id: number }) => h.id === 116).pinned).toBe(1);
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

  it('signed out, nothing touches GitHub: not me, login, logout, nor any other route; a malformed cookie is a 401', async () => {
    const { f, go } = await setup({ SITE_PASSWORD: 'pw', SESSION_SECRET: 's' }, { publish: false });
    const before = f.calls.length;
    expect((await (await go('/api/me')).json())).toEqual({ authRequired: true, username: null });
    expect((await go('/api/logout', { method: 'POST' })).status).toBe(401);
    expect((await go('/api/login', postJson({ username: 'Chip', password: 'bad' }))).status).toBe(401);
    for (const path of ['/api/flips', '/api/settings', '/api/houses', '/api/ledger', '/api/flips?gone=1']) expect((await go(path)).status, path).toBe(401);
    expect((await go('/api/settings', { headers: { cookie: `${COOKIE}=%E0%A4%A` } })).status).toBe(401);
    expect((await go('/api/me', { headers: { cookie: `${COOKIE}=%zz` } })).status).toBe(200);
    expect((await go('/', {})).status).toBe(404);
    expect(f.calls.length).toBe(before);
    expect(f.releases).toHaveLength(0);
    // Signed in: login and me still answer without GitHub.
    const login = await go('/api/login', postJson({ username: 'Chip', password: 'pw' }));
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await (await go('/api/me', { headers: { cookie } })).json()).username).toBe('Chip');
    expect(f.calls.length).toBe(before);
  });

  it('after 5 wrong passwords from one address in 10 minutes, that address waits 30 s; others do not', async () => {
    let t = 1_000_000;
    const { go } = await setup({ SITE_PASSWORD: 'pw', SESSION_SECRET: 's' }, { now: () => t });
    const from = (ip: string, password: string) => go('/api/login', postJson({ username: 'Chip', password }, { 'x-real-ip': ip }));
    for (let i = 0; i < 5; i++) { t += 60_000; expect((await from('1.1.1.1', 'bad')).status).toBe(401); }
    const r = await from('1.1.1.1', 'pw');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('30');
    expect((await from('2.2.2.2', 'pw')).status).toBe(200);
    t += 10_000;
    const w = await from('1.1.1.1', 'pw');
    expect(w.status).toBe(429);
    expect((await w.json()).error).toBe('Too many wrong passwords. Wait 20 s and try again.');
    t += 20_000;
    expect((await from('1.1.1.1', 'pw')).status).toBe(200);
    // Failures older than 10 minutes do not count.
    for (let i = 0; i < 4; i++) { t += 4 * 60_000; expect((await from('3.3.3.3', 'bad')).status).toBe(401); }
    t += 1000;
    expect((await from('3.3.3.3', 'bad')).status).toBe(401);
    // A good login cleared the count.
    expect((await from('1.1.1.1', 'bad')).status).toBe(401);
  });

  it('a write is judged after the saved ones: Sold works right after I did this, and a second Sold over the units left is refused at once', async () => {
    const { store, go } = await setup();
    const did = await go('/api/flips/f1/did', postJson({ units: 2 }));
    expect(did.status).toBe(202);
    const { event } = await did.json() as { event: string };
    // The published database has "I did this" 1 by Chip; this one is 2 by local, saved, not yet applied.
    const sold = await go('/api/ledger/2/sold', postJson({ units: 2, received: 900 }));
    expect(sold.status).toBe(202);
    const over = await go('/api/ledger/2/sold', postJson({ units: 1, received: 400 }));
    expect(over.status).toBe(400);
    // Saved naming the "I did this" by its event, not by the guessed row 2.
    expect((await readEvents(store)).map(e => e.ev!.url)).toEqual(['/api/flips/f1/did', `/api/ledger/${event.slice(7, -5)}/sold`]);
  });

  it('GET /api/flips says it is online; ?gone=1 adds at most the 200 most recently gone', async () => {
    const f = fakeGitHub();
    const gh = new GitHub({ token: f.token, repo: REPO, fetchFn: f.fetchFn, sleep: noSleep });
    const store = new SealedStore(new GitHubStore(gh, { sleep: noSleep }), KEY);
    const dir = tempDir();
    const db = openDb(dir);
    const ins = db.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at, gone_at) VALUES (?, 'craft', 'craft_auction', 1, 100, ?, 10, 'low', '{"name":"x"}', 1, 1, 1, ?)`);
    ins.run('live', 'live', null);
    for (let i = 0; i < 250; i++) ins.run(`g${i}`, 'gone', i);
    db.close();
    await putJson(store, RESULTS_KEY, JSON.stringify({ flips: [], run: null, heldBack: [] }));
    await pushDb([{ store, keep: 2 }], dir);
    const go = await serve(makeHandler({ store, gh, env: {}, dir: tempDir() }));
    expect(await (await go('/api/flips')).json()).toEqual({ flips: [], run: null, heldBack: [], online: true });
    const keys = (await (await go('/api/flips?gone=1')).json()).flips.map((x: { key: string }) => x.key);
    expect(keys).toHaveLength(201);
    expect(keys.slice(0, 3)).toEqual(['live', 'g249', 'g248']);
    expect(keys.at(-1)).toBe('g50');
  });

  it('a request keeps its copy of the database while a newer one arrives; the old copy closes when its last request ends', async () => {
    const store = new SealedStore(new LocalStore(tempDir()), KEY);
    const dir = tempDir(), site = tempDir();
    const db = openDb(dir); db.prepare(`INSERT INTO settings (key, value) VALUES ('v', 'old')`).run(); db.close();
    await pushDb([{ store, keep: 2 }], dir, { at: 1000 });
    const first = await store.list('');
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let oldPath = '';
    const slow = useSiteDb(store, first, async s => { oldPath = s.path; await held; return (s.ro.prepare(`SELECT value FROM settings WHERE key = 'v'`).get() as { value: string }).value; }, { dir: site });
    await new Promise(r => setTimeout(r, 20));
    const db2 = openDb(dir); db2.prepare(`UPDATE settings SET value = 'new' WHERE key = 'v'`).run(); db2.close();
    await pushDb([{ store, keep: 2 }], dir, { at: 2000 });
    const fresh = await useSiteDb(store, await store.list(''), async s => (s.ro.prepare(`SELECT value FROM settings WHERE key = 'v'`).get() as { value: string }).value, { dir: site });
    expect(fresh).toBe('new');
    expect(existsSync(oldPath)).toBe(true); // still in use
    release();
    expect(await slow).toBe('old');
    expect(existsSync(oldPath)).toBe(false);
  });

  it('a Sold names its "I did this" by event, so a refused earlier write never shifts it onto another row', async () => {
    // Chip saves "I did this" on f2 (row 2 on the site copy), then on f1 (row 3), then Sold on 2 and Sold on 3.
    const f2 = { key: 'f2', name: 'Silk', itemId: 200, perItem: 100, best: { units: 4, cost: 400, expectedProfit: 400 }, options: [] };
    const { store, go } = await setup({ SITE_PASSWORD: 'pw', SESSION_SECRET: 's' }, { seed: db => db.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at) VALUES ('f2', 'craft', 'craft_auction', 1, 200, 'live', 400, 'low', ?, 1, 1, 1)`).run(JSON.stringify(f2)) });
    const cookie = (await go('/api/login', postJson({ username: 'Chip', password: 'pw' }))).headers.get('set-cookie')!.split(';')[0]!;
    const did2 = await (await go('/api/flips/f2/did', postJson({ units: 4 }, { cookie }))).json();
    const did1 = await (await go('/api/flips/f1/did', postJson({ units: 2 }, { cookie }))).json();
    expect([did2.id, did1.id]).toEqual([2, 3]); // the site's guesses
    expect((await go('/api/ledger/2/sold', postJson({ units: 4, received: 900 }, { cookie }))).status).toBe(202);
    expect((await go('/api/ledger/3/sold', postJson({ units: 1, received: 700 }, { cookie }))).status).toBe(202);
    const saved = await readEvents(store);
    const stem = (k: string) => k.slice('events/'.length, -'.json'.length);
    expect(saved.map(e => e.ev!.url)).toEqual(['/api/flips/f2/did', '/api/flips/f1/did', `/api/ledger/${stem(did2.event)}/sold`, `/api/ledger/${stem(did1.event)}/sold`]);
    // Before the cycle, f2 went (a newer database): its "I did this" is refused, so f1's becomes row 2, not 3.
    const dir = tempDir();
    await pullDb(store, newestDb(await store.list(DB_PREFIX))!.key, dir);
    const db = openDb(dir);
    db.prepare(`DELETE FROM flips WHERE key = 'f2'`).run();
    const r = await applyEvents(db, saved, () => {});
    expect(r.applied.map(a => a.status)).toEqual([404, 200, 400, 200]);
    const rows = db.prepare('SELECT id, action, did_id, flip_key, units, received, event FROM user_actions ORDER BY id').all();
    expect(rows).toEqual([
      expect.objectContaining({ id: 1, action: 'did', flip_key: 'f1', units: 5, event: null }),
      expect.objectContaining({ id: 2, action: 'did', flip_key: 'f1', units: 2, event: did1.event }),
      expect.objectContaining({ id: 3, action: 'sold', did_id: 2, flip_key: 'f1', units: 1, received: 700 }),
    ]);
    // The Ledger shows both refusals; the Sold says why.
    const refused = JSON.parse(ledgerFile(db)).refused as Array<{ action: string; flipKey: string; reason: string }>;
    expect(refused.map(x => [x.action, x.flipKey, x.reason])).toEqual([['did', 'f2', 'No such flip.'], ['sold', 'f2', 'The "I did this" it sells from was not applied (No such flip.).']]);
    db.close();
  });
});
