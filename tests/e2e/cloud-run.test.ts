/**
 * The cloud cycle (src/cloud/run.ts) end to end against the local folder store, with nothing stubbed but Blizzard's
 * HTTP (the fake from tests/helpers.ts, as in goldens.test.ts) and the daily dataset refresh. Chip's houses are 111
 * and a pinned Blackwater house 116; house 110 is tracked too and must never be polled in the cloud.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { openDb, type DB } from '../../src/store/db.ts';
import { LocalStore } from '../../src/cloud/localStore.ts';
import { SupabaseStore } from '../../src/cloud/supabaseStore.ts';
import { cloudRun, parseRawKey, type CloudRunResult } from '../../src/cloud/run.ts';
import { DB_KEY, RESULTS_KEY, ENGINE_LOCK, pullDb, pushDb } from '../../src/cloud/layout.ts';
import { buildServer } from '../../src/server/server.ts';
import { tempDir, fakeBlizzard } from '../helpers.ts';
import { fakeSupabase } from '../fakeSupabase.ts';
import type { BlobStore } from '../../src/cloud/store.ts';

const H = 3600_000;
const ITEM = 2589; // Linen Cloth, a commodity
const GEAR = 720;  // an equipment auction

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
  return { ...blizz, polled, publishes, next: () => { i++; }, setIndex: (n: number) => { i = n; } };
}

/** The store before the first cycle: Chip's database with 111 and 116 pinned, plus raw files to prune and keep. */
async function seed(store: BlobStore) {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES
    (110, 'Alliance Auction House', 'alliance', 0.05, 1, 0), (111, 'Alliance Auction House', 'alliance', 0.05, 1, 1),
    (116, 'Blackwater Auction House', 'blackwater', 0.15, 1, 1)`);
  db.close();
  await pushDb(store, dir);
  const old = Date.now() - 20 * 86_400_000;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  await store.put(`raw/${day(old)}/111-auctions-${old}.json.gz`, gzipSync('[]'));
  const recent = Date.now() - 3 * 86_400_000;
  await store.put(`raw/${day(recent)}/110-auctions-${recent}.json.gz`, gzipSync('[]'));
  return { old: `raw/${day(old)}/111-auctions-${old}.json.gz`, recent: `raw/${day(recent)}/110-auctions-${recent}.json.gz` };
}

async function openStored(store: BlobStore): Promise<{ db: DB; dir: string }> {
  const dir = tempDir();
  await pullDb(store, dir);
  return { db: openDb(dir), dir };
}

const fakeDaily = async (_e: unknown, _db: DB, _c: unknown, dataDir: string) => {
  mkdirSync(join(dataDir, 'datasets', 'wago', '1.60.1.1'), { recursive: true });
  writeFileSync(join(dataDir, 'datasets', 'wago', '1.60.1.1', 'Item.csv'), 'ID,Name\n2589,Linen Cloth\n');
  return true;
};
/** The start up fills read EG Link and wago.tools over the network; the tests count calls instead. */
let fillCalls = 0;
const fakeFills = async () => { fillCalls++; };

describe('cloud cycle against the local store', () => {
  const store = new LocalStore(tempDir());
  const m = market();
  const run = (extra: Partial<Parameters<typeof cloudRun>[0]> = {}) => cloudRun({ store, client: m.client, waitForPublishMin: 0, probeEveryMs: 10, daily: fakeDaily, fills: fakeFills, log: () => {}, ...extra });
  let seeded: Awaited<ReturnType<typeof seed>>;
  const R: CloudRunResult[] = [];

  beforeAll(async () => {
    seeded = await seed(store);
    R.push(await run());       // publish A
    m.next();
    R.push(await run());       // publish B: the cheapest linen stack and one helm sold
  });

  it('first cycle: collects Chip two houses only, both kinds, and pushes their raw snapshots', async () => {
    expect(R[0]!.status).toBe('done');
    expect(R[0]!.refresh).toBe('new');
    expect(R[0]!.publishes.map(p => `${p.house} ${p.kind}`).sort()).toEqual(['111 auctions', '111 commodities', '116 auctions', '116 commodities']);
    expect(R[0]!.rawPushed).toBe(4);
    expect(m.polled).not.toContain(110);
  });

  it('second cycle: pulls the last raw, differences against it and counts the sales', async () => {
    expect(R[1]!.refresh).toBe('new');
    expect(R[1]!.rawPulled).toBe(4);
    expect(R[1]!.rawPushed).toBe(4);
    const { db } = await openStored(store);
    const sold = db.prepare(`SELECT s.house_id, s.item_id, s.gone_listings, s.sold_units FROM item_stats s JOIN snapshots n ON n.id = s.snapshot_id
      WHERE n.last_modified = ? ORDER BY s.house_id, s.item_id`).all(m.publishes[1]!) as Array<{ house_id: number; item_id: number; gone_listings: number | null; sold_units: number | null }>;
    for (const house of [111, 116]) {
      const linen = sold.find(r => r.house_id === house && r.item_id === ITEM)!;
      expect(linen.gone_listings).toBe(1);
      expect(linen.sold_units).toBeGreaterThan(0);
      const gear = sold.find(r => r.house_id === house && r.item_id === GEAR)!;
      expect(gear.gone_listings).toBe(1);
    }
    // The first publish stays a first sight: nothing to difference against.
    const first = db.prepare(`SELECT COUNT(*) n FROM item_stats s JOIN snapshots n ON n.id = s.snapshot_id WHERE n.last_modified = ? AND s.gone_listings IS NOT NULL`).get(m.publishes[0]!) as { n: number };
    expect(first.n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(8);
    db.close();
  });

  it('results.json is exactly what GET /api/flips answers on the pushed database', async () => {
    const { db, dir } = await openStored(store);
    const app = buildServer({ db, engine: null, client: null, port: 0, dataDir: dir });
    const api = await app.inject({ method: 'GET', url: '/api/flips' });
    await app.close();
    const results = JSON.parse(new TextDecoder().decode((await store.get(RESULTS_KEY))!.body));
    expect(results).toEqual(api.json());
    expect(Object.keys(results).sort()).toEqual(['flips', 'heldBack', 'run']);
    expect(results.run).not.toBeNull();
    db.close();
  });

  it('prunes raw older than 14 days and keeps the rest', async () => {
    expect(await store.get(seeded.old)).toBeNull();
    expect(await store.get(seeded.recent)).not.toBeNull();
    expect(R[0]!.rawPruned).toBe(1);
    const raw = (await store.list('raw/')).map(o => parseRawKey(o.key)!);
    expect(raw.filter(r => r.house === 111 || r.house === 116).length).toBe(8);
  });

  it('caches the daily datasets in the store, once a day', async () => {
    expect(R[0]!.daily).toBe('ok');
    expect(R[1]!.daily).toBe('not due');
    // The fills run with the daily refresh, and again only while a dataset an update added is still empty.
    expect(fillCalls).toBeGreaterThanOrEqual(1);
    expect((await store.list('datasets/')).map(o => o.key)).toEqual(['datasets/wago/1.60.1.1/Item.csv.gz']);
  });

  it('a rerun with nothing new is safe: a 304, flips rerun on the stored data, nothing duplicated', async () => {
    const before = (await store.list('raw/')).length;
    const r = await run();
    expect(r.status).toBe('done');
    expect(r.refresh).toBe('unchanged');
    expect(r.rawPushed).toBe(0);
    expect((await store.list('raw/')).length).toBe(before);
    const { db } = await openStored(store);
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(8);
    db.close();
    expect(await store.lockHolder('engine')).toBeNull();
  });

  it('when the lock is held it exits cleanly, says who holds it and changes nothing', async () => {
    const release = await store.lock(ENGINE_LOCK, 60_000, 'the site, saving a Done');
    const before = await store.head(DB_KEY);
    const resultsBefore = await store.head(RESULTS_KEY);
    m.next(); // a new publish waits, unread
    const r = await run();
    expect(r.status).toBe('locked');
    expect(r.message).toMatch(/the site, saving a Done/);
    expect((await store.head(DB_KEY))!.etag).toBe(before!.etag);
    expect((await store.head(RESULTS_KEY))!.etag).toBe(resultsBefore!.etag);
    await release!();
    // Once free, the next run picks the publish up.
    const after = await run();
    expect(after.refresh).toBe('new');
  });

  it('waits for the next publish with If-Modified-Since before taking the lock, then collects it', async () => {
    setTimeout(() => m.next(), 150);
    const r = await run({ waitForPublishMin: 1, probeEveryMs: 40 });
    expect(r.refresh).toBe('new');
    expect(r.waitedMs).toBeGreaterThanOrEqual(100);
    expect(r.waitedMs).toBeLessThan(10_000);
  });

  it('releases the lock when the cycle fails', async () => {
    const bad = Object.assign(Object.create(m.client), { get: async () => { throw new Error('Blizzard down'); } }) as typeof m.client;
    const broken = new LocalStore(tempDir());
    await seed(broken);
    await expect(cloudRun({ store: broken, client: bad, waitForPublishMin: 0, daily: fakeDaily, fills: fakeFills, log: () => {} })).rejects.toThrow(/Blizzard down/);
    expect(await broken.lockHolder('engine')).toBeNull();
  });
});

describe('cloud cycle against Supabase Storage (fake server)', () => {
  it('runs the same two cycles through the REST store and counts the bytes', async () => {
    const f = fakeSupabase();
    const store = new SupabaseStore({ url: 'https://proj.supabase.co', key: 'service-key-123', bucket: f.bucket, fetchFn: f.fetchFn });
    await seed(store);
    const m = market();
    const opts = { store, client: m.client, waitForPublishMin: 0, probeEveryMs: 10, daily: fakeDaily, fills: fakeFills, log: () => {} };
    const a = await cloudRun(opts);
    m.next();
    const b = await cloudRun(opts);
    expect([a.refresh, b.refresh]).toEqual(['new', 'new']);
    expect(b.rawPulled).toBe(4);
    expect(b.bytesUp).toBeGreaterThan(0);
    expect(b.bytesDown).toBeGreaterThan(0);
    expect(f.objects.has(RESULTS_KEY)).toBe(true);
    expect(f.objects.has(DB_KEY)).toBe(true);
    expect([...f.objects.keys()].some(k => k.startsWith('locks/'))).toBe(false);
  });
});
