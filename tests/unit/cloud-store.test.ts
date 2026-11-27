/**
 * The cloud store (brief item 3): one contract run on the local folder and on GitHub (a fake REST API behind a mocked
 * fetch, tests/fakeGitHub.ts), then GitHub's own paths (replace by upload then delete, inbox conflicts, rate limits,
 * branch creation) and the seal (src/cloud/crypto.ts).
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalStore } from '../../src/cloud/localStore.ts';
import { GitHubStore } from '../../src/cloud/githubStore.ts';
import { GitHub, GitHubApiError, dispatchOrJoin, runStatus } from '../../src/cloud/githubApi.ts';
import { SealedStore, seal, unseal, dataKey } from '../../src/cloud/crypto.ts';
import { storeFromEnv } from '../../src/cloud/layout.ts';
import type { BlobStore } from '../../src/cloud/store.ts';
import { tempDir } from '../helpers.ts';
import { fakeGitHub, REPO } from '../fakeGitHub.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const noSleep = async () => {};
const gh = (f = fakeGitHub()) => ({ f, api: new GitHub({ token: f.token, repo: REPO, fetchFn: f.fetchFn, sleep: noSleep }) });
const ghStore = (f = fakeGitHub()) => { const g = gh(f); return { f, store: new GitHubStore(g.api, { sleep: noSleep }) }; };
const KEY = randomBytes(32);

const impls: Array<[string, () => BlobStore]> = [
  ['local folder', () => new LocalStore(tempDir())],
  ['github', () => ghStore().store],
  ['github, sealed', () => new SealedStore(ghStore().store, KEY)],
];

describe.each(impls)('blob store contract: %s', (_name, make) => {
  it('put, get and delete round trip; a missing key is null, not an error', async () => {
    const s = make();
    expect(await s.get('results.json')).toBeNull();
    await s.put('results.json', enc('one'));
    const a = await s.get('results.json');
    expect(dec(a!.body)).toBe('one');
    await s.put('results.json', enc('two!'));
    const b = await s.get('results.json');
    expect(dec(b!.body)).toBe('two!');
    expect(b!.etag).not.toBe(a!.etag);
    expect((await s.list('')).map(o => o.key)).toEqual(['results.json']);
    await s.delete('results.json');
    expect(await s.get('results.json')).toBeNull();
    await s.delete('results.json'); // deleting a missing key is fine
  });

  it('list by prefix, sorted; inbox events listed apart from the assets', async () => {
    const s = make();
    for (const k of ['wowf-2.db.gz', 'wowf-1.db.gz', 'ledger.json', 'events/0002-b.json', 'events/0001-a.json']) await s.put(k, enc(k));
    expect((await s.list('wowf-')).map(o => o.key)).toEqual(['wowf-1.db.gz', 'wowf-2.db.gz']);
    expect((await s.list('events/')).map(o => o.key)).toEqual(['events/0001-a.json', 'events/0002-b.json']);
    expect(dec((await s.get('events/0002-b.json'))!.body)).toBe('events/0002-b.json');
    await s.delete('events/0001-a.json');
    expect((await s.list('events/')).map(o => o.key)).toEqual(['events/0002-b.json']);
    expect(await s.list('nothing')).toEqual([]);
  });
});

describe('GitHub store paths', () => {
  it('makes the data release on first use and the data-inbox branch on the first event', async () => {
    const { f, store } = ghStore();
    expect(await store.list('')).toEqual([]);
    expect(f.releases.map(r => r.tag)).toEqual(['data']);
    expect(f.branches.has('data-inbox')).toBe(false);
    await store.put('events/0001-a.json', enc('x'));
    expect(f.branches.has('data-inbox')).toBe(true);
    expect(f.calls.filter(c => c.startsWith('POST') && c.includes('/git/refs'))).toHaveLength(1);
    // An orphan with only a README: no workflow files, so Contents write is enough (verification G14).
    expect(f.branchCommit('data-inbox')).toEqual({ parents: [], paths: ['README.md'] });
    expect(f.calls.some(c => c.includes('/git/ref/heads/main'))).toBe(false);
  });

  it('uploads to uploads.github.com; replacing an asset uploads the new one first, then deletes the old and renames', async () => {
    const { f, store } = ghStore();
    await store.put('results.json', enc('old'));
    const oldId = f.assets()[0]!.id;
    f.calls.length = 0;
    await store.put('results.json', enc('new'));
    const upload = f.calls.findIndex(c => c.startsWith('POST uploads:') && c.includes('name=results.json.'));
    const del = f.calls.findIndex(c => c === `DELETE /repos/${REPO}/releases/assets/${oldId}`);
    const rename = f.calls.findIndex(c => c.startsWith('PATCH'));
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(upload);
    expect(rename).toBeGreaterThan(del);
    expect(f.assets().map(a => a.name)).toEqual(['results.json']);
    expect(dec((await store.get('results.json'))!.body)).toBe('new');
  });

  it('an upload that meets an existing name (422) replaces it instead of failing', async () => {
    const f = fakeGitHub();
    const a = ghStore(f).store, b = ghStore(f).store;
    await a.list(''); await b.list(''); // both listed before either uploaded
    await a.put('ledger.json', enc('a'));
    await b.put('ledger.json', enc('b'));
    expect(f.assets().map(x => x.name)).toEqual(['ledger.json']);
    expect(dec((await a.get('ledger.json'))!.body)).toBe('b');
  });

  it('get re-lists when the asset was replaced since the listing', async () => {
    const f = fakeGitHub();
    const reader = ghStore(f).store, writer = ghStore(f).store;
    await writer.put('results.json', enc('v1'));
    expect(dec((await reader.get('results.json'))!.body)).toBe('v1');
    await writer.put('results.json', enc('v2'));
    expect(dec((await reader.get('results.json'))!.body)).toBe('v2');
  });

  it('inbox writes retry on 409 conflicts and give up with a clear error after five', async () => {
    const { f, store } = ghStore();
    f.branches.add('data-inbox');
    f.knobs.conflicts = 3;
    await store.put('events/0001-a.json', enc('x'));
    expect(f.files.has('events/0001-a.json')).toBe(true);
    f.knobs.conflicts = 9;
    await expect(store.put('events/0002-b.json', enc('y'))).rejects.toThrow(/409/);
  });

  it('deleting an inbox file uses the sha from the listing; a missing one is fine', async () => {
    const { f, store } = ghStore();
    await store.put('events/0001-a.json', enc('x'));
    await store.list('events/');
    f.calls.length = 0;
    await store.delete('events/0001-a.json');
    expect(f.calls.filter(c => c.startsWith('GET'))).toEqual([]);
    expect(f.files.size).toBe(0);
    await store.delete('events/0001-a.json');
  });

  it('a short rate limit is waited out; a long one is an error that says when', async () => {
    const f = fakeGitHub();
    const waits: number[] = [];
    const api = new GitHub({ token: f.token, repo: REPO, fetchFn: f.fetchFn, sleep: async ms => { waits.push(ms); } });
    const store = new GitHubStore(api, { sleep: noSleep });
    f.knobs.before.push({ status: 403, headers: { 'retry-after': '2' } }, { status: 429, headers: { 'retry-after': '1' } });
    expect(await store.list('')).toEqual([]);
    expect(waits).toEqual([2000, 1000]);
    f.knobs.before.push({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
    const err = await store.put('results.json', enc('x')).catch(e => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.rateLimited).toBe(true);
    expect(err.message).toMatch(/rate limit.*try again after \d\d:\d\d UTC/);
  });

  it('a 5xx is retried twice; a 403 that is not a rate limit fails at once', async () => {
    const f = fakeGitHub();
    const { api } = gh(f);
    f.knobs.before.push({ status: 502 }, { status: 503 });
    expect((await api.json('GET', '~')).body).toEqual({ default_branch: 'main' });
    f.knobs.before.push({ status: 403, body: JSON.stringify({ message: 'Resource not accessible by personal access token' }) });
    await expect(api.json('GET', '~')).rejects.toThrow(/403.*not accessible/);
  });

  it('sends the token as a Bearer header; a wrong token is refused', async () => {
    const f = fakeGitHub();
    const bad = new GitHubStore(new GitHub({ token: 'nope', repo: REPO, fetchFn: f.fetchFn, sleep: noSleep }));
    await expect(bad.list('')).rejects.toThrow(/401/);
  });
});

describe('Refresh on GitHub Actions', () => {
  it('dispatches the collect workflow and finds the new run', async () => {
    const { f, api } = gh();
    f.addRun('completed');
    const r = await dispatchOrJoin(api, { ref: 'main', sleep: noSleep });
    expect(r.joined).toBe(false);
    expect(r.run?.status).toBe('queued');
    expect(f.calls).toContain(`POST /repos/${REPO}/actions/workflows/collect.yml/dispatches`);
    f.runs.at(-1)!.status = 'completed';
    expect((await runStatus(api, { run: r.run!.id }))?.status).toBe('completed');
  });

  it('joins a run already queued or in progress instead of starting another', async () => {
    const { f, api } = gh();
    const running = f.addRun('in_progress');
    const r = await dispatchOrJoin(api, { ref: 'main', sleep: noSleep });
    expect(r).toMatchObject({ joined: true, run: { id: running.id } });
    expect(f.calls.some(c => c.includes('/dispatches'))).toBe(false);
  });

  it('a dispatch whose run has not appeared yet answers with no run; status by time finds it later', async () => {
    const { f, api } = gh();
    f.knobs.onDispatch = () => {};
    const r = await dispatchOrJoin(api, { ref: 'main', sleep: noSleep, findTries: 2 });
    expect(r.run).toBeNull();
    f.addRun('in_progress', 'workflow_dispatch');
    expect((await runStatus(api, { since: r.since }))?.status).toBe('in_progress');
  });
});

describe('the seal', () => {
  const secret = enc('Chip did 5 Runecloth Bandage');
  it('round trips, and every seal of the same bytes differs', () => {
    const a = seal(secret, KEY), b = seal(secret, KEY);
    expect(dec(unseal(a, KEY))).toBe(dec(secret));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
  it('a wrong key fails', () => {
    expect(() => unseal(seal(secret, KEY), randomBytes(32))).toThrow(/could not decrypt/);
  });
  it('a changed byte fails, anywhere in the file', () => {
    const s = seal(secret, KEY);
    for (const i of [5, 20, s.length - 1]) { const t = new Uint8Array(s); t[i]! ^= 1; expect(() => unseal(t, KEY)).toThrow(); }
    expect(() => unseal(enc('plain text, never sealed'), KEY)).toThrow(/not a sealed/);
  });
  it('DATA_KEY: missing or the wrong length refuses to start (fail closed)', () => {
    expect(() => dataKey({})).toThrow(/DATA_KEY is missing/);
    expect(() => dataKey({ DATA_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
    expect(dataKey({ DATA_KEY: KEY.toString('base64') }).equals(KEY)).toBe(true);
    expect(() => storeFromEnv({ GITHUB_TOKEN: 't', GITHUB_REPO: REPO })).toThrow(/DATA_KEY/);
    expect(() => storeFromEnv({ STORE: 'local', STORE_DIR: tempDir() })).toThrow(/DATA_KEY/);
  });
  it('nothing reaches GitHub in clear: a name and an item never appear in the stored bytes', async () => {
    const f = fakeGitHub();
    const store = new SealedStore(ghStore(f).store, KEY);
    await store.put('ledger.json', secret);
    await store.put('events/0001-a.json', secret);
    const all = f.allBytes();
    expect(all).toHaveLength(2);
    for (const b of all) for (const word of ['Chip', 'Runecloth']) expect(Buffer.from(b).includes(word)).toBe(false);
    expect(dec((await store.get('events/0001-a.json'))!.body)).toBe(dec(secret));
  });
});
