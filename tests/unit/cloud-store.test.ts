/**
 * The blob store (src/cloud/store.ts): the same contract run on the local folder and on Supabase Storage, the latter
 * against a fake Storage server behind a mocked fetch. The fake follows the REST API as read from storage-js
 * (src/cloud/supabaseStore.ts header) and answers errors in both the old style (400 with statusCode in the body) and
 * the new one (404, 409), so the store is proven against either until it runs against a real project.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalStore } from '../../src/cloud/localStore.ts';
import { SupabaseStore } from '../../src/cloud/supabaseStore.ts';
import { lockKey, type BlobStore } from '../../src/cloud/store.ts';
import { tempDir } from '../helpers.ts';

import { fakeSupabase, SUPABASE_URL as URL0, SUPABASE_KEY as KEY } from '../fakeSupabase.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const impls: Array<[string, () => BlobStore]> = [
  ['local folder', () => new LocalStore(tempDir())],
  ['supabase (new errors)', () => new SupabaseStore({ url: URL0, key: KEY, bucket: 'gold-finder', fetchFn: fakeSupabase().fetchFn })],
  ['supabase (old 400 errors)', () => new SupabaseStore({ url: URL0, key: KEY, bucket: 'gold-finder', fetchFn: fakeSupabase({ oldErrors: true }).fetchFn })],
];

afterEach(() => { vi.useRealTimers(); });

describe.each(impls)('blob store contract: %s', (_name, make) => {
  it('put, get, head and delete round trip; a missing key is null, not an error', async () => {
    const s = make();
    expect(await s.get('wowf.db.gz')).toBeNull();
    expect(await s.head('wowf.db.gz')).toBeNull();
    await s.put('wowf.db.gz', enc('one'));
    const a = await s.get('wowf.db.gz');
    expect(dec(a!.body)).toBe('one');
    const h = await s.head('wowf.db.gz');
    expect(h!.size).toBe(3);
    expect(h!.etag).toBe(a!.etag);
    // Overwrite changes the ETag.
    await s.put('wowf.db.gz', enc('two!'));
    const b = await s.get('wowf.db.gz');
    expect(dec(b!.body)).toBe('two!');
    expect(b!.etag).not.toBe(a!.etag);
    await s.delete('wowf.db.gz');
    expect(await s.get('wowf.db.gz')).toBeNull();
    await s.delete('wowf.db.gz'); // deleting a missing key is fine
  });

  it('list returns every key under a prefix, through folders, and a partial name prefix', async () => {
    const s = make();
    for (const k of ['raw/2026-11-25/111-auctions-1.json.gz', 'raw/2026-11-26/111-auctions-2.json.gz', 'raw/2026-11-26/116-commodities-3.json.gz', 'results.json', 'datasets/wago/1.6/Item.csv.gz'])
      await s.put(k, enc(k));
    expect((await s.list('raw/')).map(o => o.key)).toEqual(['raw/2026-11-25/111-auctions-1.json.gz', 'raw/2026-11-26/111-auctions-2.json.gz', 'raw/2026-11-26/116-commodities-3.json.gz']);
    expect((await s.list('raw/2026-11-26/116')).map(o => o.key)).toEqual(['raw/2026-11-26/116-commodities-3.json.gz']);
    expect((await s.list('datasets/')).map(o => o.key)).toEqual(['datasets/wago/1.6/Item.csv.gz']);
    expect((await s.list('')).length).toBe(5);
    expect((await s.list('raw/2026-11-25/'))[0]!.size).toBe('raw/2026-11-25/111-auctions-1.json.gz'.length);
    expect(await s.list('nothing/')).toEqual([]);
  });

  it('lock: one holder at a time; release frees it', async () => {
    const s = make();
    const r1 = await s.lock('engine', 60_000, 'hourly job');
    expect(r1).toBeTypeOf('function');
    expect(await s.lock('engine', 60_000, 'site')).toBeNull();
    expect((await s.lockHolder!('engine'))!.owner).toBe('hourly job');
    // A different name is a different lock.
    const other = await s.lock('other', 60_000, 'site');
    expect(other).toBeTypeOf('function');
    await r1!();
    expect(await s.lockHolder!('engine')).toBeNull();
    const r2 = await s.lock('engine', 60_000, 'site');
    expect(r2).toBeTypeOf('function');
    await r2!(); await other!();
  });

  it('lock: an expired lock is taken over, and the old holder releasing it later does not free the new one', async () => {
    const s = make();
    const old = await s.lock('engine', 1_000, 'crashed run');
    expect(old).toBeTypeOf('function');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5_000);
    const fresh = await s.lock('engine', 60_000, 'next run');
    expect(fresh).toBeTypeOf('function');
    await old!(); // the crashed run wakes up and releases: must not touch the next run's lock
    expect((await s.lockHolder!('engine'))!.owner).toBe('next run');
    expect(await s.lock('engine', 60_000, 'third')).toBeNull();
    await fresh!();
    expect(await s.lockHolder!('engine')).toBeNull();
  });

  it('lock: an unreadable lock object counts as expired', async () => {
    const s = make();
    await s.put(lockKey('engine'), enc('not json'));
    const r = await s.lock('engine', 60_000, 'next run');
    expect(r).toBeTypeOf('function');
    await r!();
  });
});

describe('Supabase Storage REST calls', () => {
  it('sends the key as apikey and Bearer, upserts with x-upsert true, creates the lock with x-upsert false, and uses the documented paths', async () => {
    const f = fakeSupabase();
    const s = new SupabaseStore({ url: `${URL0}/`, key: KEY, bucket: 'gold-finder', fetchFn: f.fetchFn });
    await s.put('raw/2026-11-26/a b.json.gz', enc('x'), 'application/gzip');
    await s.get('raw/2026-11-26/a b.json.gz');
    await s.head('raw/2026-11-26/a b.json.gz');
    await s.list('raw/');
    await s.delete('raw/2026-11-26/a b.json.gz');
    const release = await s.lock('engine', 60_000, 'job');
    await release!();
    for (const c of f.calls) { expect(c.headers.apikey).toBe(KEY); expect(c.headers.authorization).toBe(`Bearer ${KEY}`); }
    expect(f.calls.map(c => `${c.method} ${c.path}`).slice(0, 6)).toEqual([
      'POST /storage/v1/object/gold-finder/raw/2026-11-26/a%20b.json.gz',
      'GET /storage/v1/object/gold-finder/raw/2026-11-26/a%20b.json.gz',
      'HEAD /storage/v1/object/gold-finder/raw/2026-11-26/a%20b.json.gz',
      'POST /storage/v1/object/list/gold-finder', // the raw folder
      'POST /storage/v1/object/list/gold-finder', // its day folder
      'DELETE /storage/v1/object/gold-finder',
    ]);
    expect(f.calls[0]!.headers['x-upsert']).toBe('true');
    expect(f.calls[0]!.headers['content-type']).toBe('application/gzip');
    expect(f.calls.find(c => c.method === 'DELETE')!.path).toBe('/storage/v1/object/gold-finder');
    const lockCreate = f.calls.find(c => c.method === 'POST' && c.path.endsWith('/locks/engine.json'))!;
    expect(lockCreate.headers['x-upsert']).toBe('false');
  });

  it('a failed call throws with the status, never reads as missing', async () => {
    const fetchFn = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const s = new SupabaseStore({ url: URL0, key: KEY, bucket: 'b', fetchFn });
    await expect(s.get('x')).rejects.toThrow(/500/);
    await expect(s.head('x')).rejects.toThrow(/500/);
    await expect(s.put('x', enc('1'))).rejects.toThrow(/500/);
    await expect(s.lock('engine', 1000, 'me')).rejects.toThrow(/500/);
    await expect(s.list('raw/')).rejects.toThrow(/500/);
  });

  it('a wrong key (400 unauthorized) on get is an error, not a missing object', async () => {
    const f = fakeSupabase();
    const s = new SupabaseStore({ url: URL0, key: 'wrong', bucket: 'gold-finder', fetchFn: f.fetchFn });
    await expect(s.get('x')).rejects.toThrow(/400/);
  });

  it('list pages past 1000 entries in one folder; deleteMany sends chunks of at most 500', async () => {
    const f = fakeSupabase();
    const s = new SupabaseStore({ url: URL0, key: KEY, bucket: 'gold-finder', fetchFn: f.fetchFn });
    for (let i = 0; i < 1203; i++) f.objects.set(`raw/2026-11-26/111-auctions-${i}.json.gz`, { body: enc('x'), etag: 'e', type: 'application/gzip', at: 0 });
    const all = await s.list('raw/');
    expect(all.length).toBe(1203);
    await s.deleteMany(all.map(o => o.key));
    expect(f.objects.size).toBe(0);
    expect(f.calls.filter(c => c.method === 'DELETE').length).toBe(3);
  });

  it('refuses to start without a URL, key or bucket', () => {
    expect(() => new SupabaseStore({ url: '', key: KEY, bucket: 'b' })).toThrow(/SUPABASE_URL/);
    expect(() => new SupabaseStore({ url: URL0, key: '', bucket: 'b' })).toThrow();
  });
});
