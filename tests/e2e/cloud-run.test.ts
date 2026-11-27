/**
 * The cloud cycle (src/cloud/run.ts) end to end, with nothing stubbed but Blizzard's HTTP (the fake from
 * tests/helpers.ts, as in goldens.test.ts) and the daily dataset refresh. The cloud store is a sealed folder (and, in
 * the last block, the fake GitHub API); the Actions cache is a folder that survives between runs, or is wiped to act as
 * an evicted cache. Chip's houses are 111 and, once pinned through the inbox, Blackwater 116; 110 is tracked too and
 * must never be polled in the cloud.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, type DB } from '../../src/store/db.ts';
import { LocalStore } from '../../src/cloud/localStore.ts';
import { GitHubStore } from '../../src/cloud/githubStore.ts';
import { GitHub } from '../../src/cloud/githubApi.ts';
import { SealedStore } from '../../src/cloud/crypto.ts';
import { cloudRun, CLOUD_RETENTION, type CloudRunResult, type CloudRunOptions } from '../../src/cloud/run.ts';
import { RESULTS_KEY, LEDGER_KEY, DB_PREFIX, newestDb, pullDb, pushDb, getJson } from '../../src/cloud/layout.ts';
import { addEvent, APPLIED_KV, type LedgerFile } from '../../src/cloud/inbox.ts';
import { buildServer } from '../../src/server/server.ts';
import { tempDir, fakeBlizzard } from '../helpers.ts';
import { fakeGitHub, REPO } from '../fakeGitHub.ts';
import type { BlobStore } from '../../src/cloud/store.ts';

const H = 3600_000;
const ITEM = 2589; // Linen Cloth, a commodity
const GEAR = 720;  // an equipment auction
const KEY = randomBytes(32);

/** A small market whose second publish sells the cheapest linen stack and one helm. */
function market() {
  const t0 = Math.floor((Date.now() - 2 * H) / 1000) * 1000;
  const publishes = [t0, t0 + H, t0 + 2 * H, t0 + 3 * H, t0 + 4 * H].map(t => new Date(t).toUTCString());
  let i = 0;
  const commodities = (house: number) => {
    const base = house * 1000;
    const rows = [
      { id: base + 1, item: { id: ITEM }, quantity: 20, unit_price: 100, time_left: 'VERY_LONG' },
      { id: base + 2, item: { id: ITEM }, quantity: 20, unit_price: 110, time_left: 'VERY_LONG' },
      { id: base + 3, item: { id: ITEM }, quantity: 40, unit_price: 150, time_left: 'VERY_LONG' },
    ];
    return i === 0 ? rows : rows.slice(1);
  };
  const auctions = (house: number) => {
    const base = house * 1000 + 500;
    const rows = [
      { id: base + 1, item: { id: GEAR }, buyout: 50_000, quantity: 1, time_left: 'VERY_LONG' },
      { id: base + 2, item: { id: GEAR }, buyout: 90_000, quantity: 1, time_left: 'VERY_LONG' },
    ];
    return i === 0 ? rows : rows.slice(1);
  };
  const polled: number[] = [];
  const routes: Record<string, () => { body: unknown; lastModified?: string; status?: number }> = {
    '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [
      { id: 110, name: 'Alliance Auction House' }, { id: 111, name: 'Alliance Auction House' }, { id: 116, name: 'Blackwater Auction House' }] } }),
  };
  for (const house of [110, 111, 116]) {
    routes[`/data/wow/ruleset/2/auctions/${house}`] = () => { polled.push(house); return { lastModified: publishes[i]!, body: { id: house, auctions: auctions(house) } }; };
    routes[`/data/wow/ruleset/2/auctions/${house}/commodities`] = () => { polled.push(house); return { lastModified: publishes[i]!, body: { auctions: commodities(house) } }; };
  }
  const blizz = fakeBlizzard(routes);
  return { ...blizz, polled, publishes, next: () => { i++; } };
}

const fakeDaily = async (_e: unknown, _db: DB, _c: unknown, dataDir: string) => {
  mkdirSync(join(dataDir, 'datasets', 'wago', '1.60.1.1'), { recursive: true });
  writeFileSync(join(dataDir, 'datasets', 'wago', '1.60.1.1', 'Item.csv'), 'ID,Name\n2589,Linen Cloth\n');
  return true;
};
let fillCalls = 0;
const fakeFills = async () => { fillCalls++; };
const silent = () => {};

/** A cloud: the sealed store, a cache folder, and how to run one cycle against them. */
function cloud(remoteInner: BlobStore = new LocalStore(tempDir())) {
  const cacheDir = tempDir();
  const remote = new SealedStore(remoteInner, KEY);
  const cache = new SealedStore(new LocalStore(join(cacheDir, 'db')), KEY);
  const m = market();
  const run = (extra: Partial<CloudRunOptions> = {}) => cloudRun({ remote, cache, dataDir: join(cacheDir, 'data'), client: m.client,
    waitForPublishMin: 0, probeEveryMs: 10, daily: fakeDaily, fills: fakeFills, log: silent, ...extra });
  const stored = async (): Promise<DB> => {
    const dir = tempDir();
    await pullDb(remote, newestDb(await remote.list(DB_PREFIX))!.key, dir);
    return openDb(dir);
  };
  const pin = (house: number, user = 'Chip') => addEvent(remote, { at: Date.now(), user, method: 'POST', url: '/api/houses/pin', contentType: 'application/json', body: JSON.stringify({ blackwater: house }) });
  return { cacheDir, remote, cache, m, run, stored, pin };
}

describe('cloud cycle: restore from nothing, the inbox, and what it publishes', () => {
  const c = cloud();
  const R: CloudRunResult[] = [];
  let pinKey = '';

  beforeAll(async () => {
    pinKey = await c.pin(116);
    R.push(await c.run());   // publish A, from nothing; the Blackwater pin comes from the inbox
    c.m.next();
    R.push(await c.run());   // publish B: the cheapest linen stack and one helm sold
  });

  it('starts fresh with no cache and no release, and collects Chip houses only, both kinds', async () => {
    expect(R[0]!.restoredFrom).toBe('fresh');
    expect(R[0]!.refresh).toBe('new');
    expect(R[0]!.publishes.map(p => `${p.house} ${p.kind}`).sort()).toEqual(['111 auctions', '111 commodities', '116 auctions', '116 commodities']);
    expect(c.m.polled).not.toContain(110);
  });

  it('applies the inbox pin once, then deletes the event', async () => {
    expect(R[0]!.events).toEqual({ applied: 1, refused: 0, skipped: 0 });
    expect(R[1]!.events).toEqual({ applied: 0, refused: 0, skipped: 0 });
    expect(await c.remote.list('events/')).toEqual([]);
    const db = await c.stored();
    expect((db.prepare('SELECT id FROM houses WHERE pinned = 1 ORDER BY id').all() as Array<{ id: number }>).map(r => r.id)).toEqual([116]);
    expect(JSON.parse((db.prepare('SELECT value FROM kv WHERE key = ?').get(APPLIED_KV) as { value: string }).value)).toEqual([pinKey]);
    db.close();
  });

  it('second cycle restores from the cache, differences against the raw kept there and counts the sales', async () => {
    expect(R[1]!.restoredFrom).toBe('cache');
    expect(R[1]!.refresh).toBe('new');
    const db = await c.stored();
    const sold = db.prepare(`SELECT s.house_id, s.item_id, s.gone_listings, s.sold_units FROM item_stats s JOIN snapshots n ON n.id = s.snapshot_id
      WHERE n.last_modified = ? ORDER BY s.house_id, s.item_id`).all(c.m.publishes[1]!) as Array<{ house_id: number; item_id: number; gone_listings: number | null; sold_units: number | null }>;
    for (const house of [111, 116]) {
      const linen = sold.find(r => r.house_id === house && r.item_id === ITEM)!;
      expect(linen.gone_listings).toBe(1);
      expect(linen.sold_units).toBeGreaterThan(0);
      expect(sold.find(r => r.house_id === house && r.item_id === GEAR)!.gone_listings).toBe(1);
    }
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(8);
    db.close();
  });

  it('results.json is exactly what GET /api/flips answers on the published database; ledger.json has the rows', async () => {
    const db = await c.stored();
    const app = buildServer({ db, engine: null, client: null, port: 0, dataDir: '' });
    const api = await app.inject({ method: 'GET', url: '/api/flips' });
    await app.close();
    const results = await getJson<Record<string, unknown>>(c.remote, RESULTS_KEY);
    expect(results).toEqual(api.json());
    expect(Object.keys(results!).sort()).toEqual(['flips', 'heldBack', 'run']);
    expect(results!.run).not.toBeNull();
    expect(await getJson<LedgerFile>(c.remote, LEDGER_KEY)).toEqual({ rows: [], applied: [pinKey] });
    db.close();
  });

  it('keeps the newest 2 databases in the release and 1 in the cache; raw and datasets stay in the cache folder only', async () => {
    expect((await c.remote.list(DB_PREFIX)).length).toBe(2);
    expect((await c.cache.list(DB_PREFIX)).length).toBe(1);
    expect((await c.remote.list('')).map(o => o.key).filter(k => !k.startsWith(DB_PREFIX)).sort()).toEqual([LEDGER_KEY, RESULTS_KEY]);
    expect(readdirSync(join(c.cacheDir, 'data', 'raw')).length).toBeGreaterThan(0);
    expect(R[1]!.rawFiles).toBe(8);
    expect(existsSync(join(c.cacheDir, 'data', 'datasets', 'wago', '1.60.1.1', 'Item.csv'))).toBe(true);
  });

  it('never leaves the plain database in the cache folder, and the sealed copy does not read as SQLite', () => {
    for (const f of ['wowf.db', 'wowf.db-wal', 'wowf.db-shm']) expect(existsSync(join(c.cacheDir, 'data', f))).toBe(false);
    const sealed = readdirSync(join(c.cacheDir, 'db'));
    expect(sealed).toHaveLength(1);
    expect(readFileSync(join(c.cacheDir, 'db', sealed[0]!)).subarray(0, 4).toString()).toBe('WFE1');
  });

  it('the daily refresh runs once a day, with cloud retention', async () => {
    expect(R[0]!.daily).toBe('ok');
    expect(R[1]!.daily).toBe('not due');
    expect(fillCalls).toBeGreaterThanOrEqual(1);
    expect(CLOUD_RETENTION).toMatchObject({ statsKeepDays: 30, backups: false });
    expect(CLOUD_RETENTION.rawKeepDays * 24).toBeGreaterThanOrEqual(72 + 24);
  });

  it('a rerun with nothing new is safe: a 304, flips rerun on the stored data, nothing duplicated', async () => {
    const r = await c.run();
    expect(r.refresh).toBe('unchanged');
    const db = await c.stored();
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(8);
    db.close();
  });

  it('the plain database is removed even when the cycle fails', async () => {
    const bad = Object.assign(Object.create(c.m.client), { get: async () => { throw new Error('Blizzard down'); } }) as typeof c.m.client;
    await expect(c.run({ client: bad })).rejects.toThrow(/Blizzard down/);
    expect(existsSync(join(c.cacheDir, 'data', 'wowf.db'))).toBe(false);
  });
});

describe('cloud cycle: restore from the release when the cache is gone', () => {
  it('an evicted cache restores the newest release asset and keeps every row', async () => {
    const c = cloud();
    await c.run();
    rmSync(c.cacheDir, { recursive: true, force: true });
    c.m.next();
    const r = await c.run();
    expect(r.restoredFrom).toBe('release');
    expect(r.bytesDown).toBeGreaterThan(0);
    const db = await c.stored();
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(4);
    db.close();
  });

  it('a release newer than the cache wins over the cache', async () => {
    const c = cloud();
    await c.run();
    const stale = readdirSync(join(c.cacheDir, 'db'))[0]!;
    const staleBytes = readFileSync(join(c.cacheDir, 'db', stale));
    c.m.next();
    await c.run();
    // The cache comes back as it was two runs ago (an older cache entry restored by prefix).
    for (const f of readdirSync(join(c.cacheDir, 'db'))) rmSync(join(c.cacheDir, 'db', f));
    writeFileSync(join(c.cacheDir, 'db', stale), staleBytes);
    c.m.next();
    const r = await c.run();
    expect(r.restoredFrom).toBe('release');
    const db = await c.stored();
    // Three publishes of house 111, both kinds: the stale cache would have left four.
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(6);
    db.close();
  });
});

describe('cloud cycle: inbox events', () => {
  it('a did and a sold apply in order, once; a refused one is dropped, not retried; a replayed name is skipped', async () => {
    const c = cloud();
    await c.run();
    // A flip on the published database, as a past run would have left it (this small market makes none).
    const dir = tempDir();
    await pullDb(c.cache, newestDb(await c.cache.list(DB_PREFIX))!.key, dir);
    const db0 = openDb(dir);
    const detail = { key: 'f1', name: 'Bandage', itemId: 100, perItem: 300, best: { units: 5, cost: 1000, expectedProfit: 1500 }, options: [] };
    db0.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at) VALUES ('f1', 'craft', 'craft_auction', 111, 100, 'live', 1500, 'low', ?, 1, 1, 1)`).run(JSON.stringify(detail));
    db0.close();
    await pushDb([{ store: c.cache, keep: 1 }], dir);
    const ev = (at: number, user: string, method: string, url: string, body: unknown) => addEvent(c.remote, { at, user, method, url, contentType: 'application/json', body: JSON.stringify(body) });
    const t = Date.now();
    const keys = [
      await ev(t, 'Chip', 'POST', '/api/flips/f1/did', { units: 2 }),
      await ev(t + 1, 'Chip', 'POST', '/api/ledger/1/sold', { units: 1, received: 900 }),
      await ev(t + 2, 'Dana', 'POST', '/api/ledger/1/sold', { units: 1, received: 900 }), // not Dana's: refused
      await ev(t + 3, 'Dana', 'PUT', '/api/settings', { alert_good_gold: 12 }),
    ];
    const r = await c.run();
    expect(r.events).toEqual({ applied: 3, refused: 1, skipped: 0 });
    const db = await c.stored();
    expect(db.prepare('SELECT action, username, units, expected_cost, received FROM user_actions ORDER BY id').all().map(x => ({ ...x }))).toEqual([
      { action: 'did', username: 'Chip', units: 2, expected_cost: 400, received: null },
      { action: 'sold', username: 'Chip', units: 1, expected_cost: null, received: 900 },
    ]);
    expect((db.prepare(`SELECT value FROM settings WHERE key = 'alert_good_gold'`).get() as { value: string }).value).toBe('12');
    expect(JSON.parse((db.prepare('SELECT value FROM kv WHERE key = ?').get(APPLIED_KV) as { value: string }).value)).toEqual(keys);
    db.close();
    expect((await getJson<LedgerFile>(c.remote, LEDGER_KEY))!.rows).toHaveLength(2);
    expect(await c.remote.list('events/')).toEqual([]);
    // The same name again, as if its delete had failed: skipped, nothing applied twice.
    await c.remote.put(keys[0]!, new TextEncoder().encode(JSON.stringify({ v: 1, at: t, user: 'Chip', method: 'POST', url: '/api/flips/f1/did', contentType: 'application/json', body: '{"units":2}' })));
    const again = await c.run();
    expect(again.events).toEqual({ applied: 0, refused: 0, skipped: 1 });
    const db2 = await c.stored();
    expect((db2.prepare('SELECT COUNT(*) n FROM user_actions').get() as { n: number }).n).toBe(2);
    db2.close();
  });

  it('an event sealed with another key is dropped and logged without its content', async () => {
    const c = cloud();
    const other = new SealedStore(c.remote.inner, randomBytes(32));
    await addEvent(other, { at: Date.now(), user: 'Chip', method: 'PUT', url: '/api/settings', contentType: 'application/json', body: '{"alert_good_gold":99}' });
    const lines: string[] = [];
    const r = await c.run({ log: m => lines.push(m) });
    expect(r.events.refused).toBe(1);
    expect(lines.some(l => /inbox .* unreadable, dropped/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/Chip|alert_good_gold/);
    expect(await c.remote.list('events/')).toEqual([]);
  });
});

describe('cloud cycle on the GitHub API (fake), sealed', () => {
  it('runs two cycles through releases and the inbox; nothing stored in clear', async () => {
    const f = fakeGitHub();
    const c = cloud(new GitHubStore(new GitHub({ token: f.token, repo: REPO, fetchFn: f.fetchFn, sleep: async () => {} }), { sleep: async () => {} }));
    await c.pin(116, 'Chip');
    const a = await c.run();
    c.m.next();
    const b = await c.run();
    expect([a.refresh, b.refresh]).toEqual(['new', 'new']);
    expect(b.bytesUp).toBeGreaterThan(0);
    expect(f.assets().map(x => x.name).filter(n => !n.startsWith(DB_PREFIX)).sort()).toEqual([LEDGER_KEY, RESULTS_KEY]);
    expect(f.assets().filter(x => x.name.startsWith(DB_PREFIX))).toHaveLength(2);
    expect(f.files.size).toBe(0);
    for (const bytes of f.allBytes()) for (const word of ['Chip', 'Linen Cloth', 'SQLite format']) expect(Buffer.from(bytes).includes(word)).toBe(false);
    expect(f.calls.some(c => c.startsWith('DELETE') && c.includes('/contents/events/'))).toBe(true);
  });
});
