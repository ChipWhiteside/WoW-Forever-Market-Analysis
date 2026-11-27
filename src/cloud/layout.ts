import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobInfo, BlobStore } from './store.ts';
import { LocalStore } from './localStore.ts';
import { GitHubStore } from './githubStore.ts';
import { GitHub } from './githubApi.ts';
import { SealedStore, dataKey } from './crypto.ts';

/**
 * The one owner of where the cloud's files live and how they move (brief item 6). The cycle (src/cloud/run.ts)
 * writes them; the site (src/cloud/vercelHandler.ts) reads them.
 *
 * Objects, in the cloud store (release `data`) and, for the database, also in the Actions cache folder:
 * - `wowf-<publish time ms>.db.gz`  the engine database, gzipped, sealed. A new name each publish; the newest 2 kept.
 * - `results.json`  the /api/flips payload, exactly what GET /api/flips answers. Overwritten each run.
 * - `ledger.json`   every user action row and the inbox events already applied (src/server/ledger.ts ledgerFile).
 * - `events/<time>-<random>.json`  the site's writes waiting for the next cycle (src/cloud/inbox.ts).
 * Raw snapshots and datasets never leave the Actions cache folder.
 */
export const DB_PREFIX = 'wowf-';
export const RESULTS_KEY = 'results.json';
export const LEDGER_KEY = 'ledger.json';
export const DB_KEEP_REMOTE = 2;
export const DB_KEEP_CACHE = 1;

export const dbKey = (publishedAt: number) => `${DB_PREFIX}${publishedAt}.db.gz`;
/** The publish time in a database key, or null for any other key. */
export function dbTime(key: string): number | null {
  const m = /^wowf-(\d+)\.db\.gz$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** The newest database object in a listing, or null. */
export function newestDb(listing: BlobInfo[]): (BlobInfo & { at: number }) | null {
  let best: (BlobInfo & { at: number }) | null = null;
  for (const o of listing) { const at = dbTime(o.key); if (at !== null && (!best || at > best.at)) best = { ...o, at }; }
  return best;
}

/** Download a database object into dir/file (default wowf.db), removing any WAL left there. Returns its gzipped size. */
export async function pullDb(store: BlobStore, key: string, dir: string, file = 'wowf.db'): Promise<number | null> {
  const got = await store.get(key);
  if (!got) return null;
  mkdirSync(dir, { recursive: true });
  for (const s of ['', '-wal', '-shm']) rmSync(join(dir, file + s), { force: true });
  writeFileSync(join(dir, file), gunzipSync(got.body));
  return got.body.length;
}

/**
 * Upload dir/wowf.db under a new name to each store, then delete the older names beyond `keep`: new first, old after,
 * so a reader always finds a whole database. The caller must have checkpointed the WAL. Returns the gzipped size.
 */
export async function pushDb(targets: Array<{ store: BlobStore; keep: number }>, dir: string, opts: { at?: number; replaces?: string | null } = {}): Promise<{ key: string; bytes: number }> {
  const body = gzipSync(readFileSync(join(dir, 'wowf.db')), { level: 6 });
  const key = dbKey(opts.at ?? Date.now());
  for (const t of targets) {
    await t.store.put(key, body, 'application/gzip');
    // `replaces`: an earlier copy from the same cycle, so a second publish in one run never pushes out the last run's.
    if (opts.replaces && opts.replaces !== key) await t.store.delete(opts.replaces);
    const old = (await t.store.list(DB_PREFIX)).filter(o => dbTime(o.key) !== null).sort((a, b) => dbTime(b.key)! - dbTime(a.key)!).slice(t.keep);
    for (const o of old) await t.store.delete(o.key);
  }
  return { key, bytes: body.length };
}

export const putJson = (store: BlobStore, key: string, body: string) => store.put(key, new TextEncoder().encode(body), 'application/json');
export async function getJson<T>(store: BlobStore, key: string): Promise<T | null> {
  const got = await store.get(key);
  return got ? JSON.parse(new TextDecoder().decode(got.body)) as T : null;
}

export interface CloudEnv {
  DATA_KEY?: string; GITHUB_TOKEN?: string; GITHUB_REPO?: string; GITHUB_REPOSITORY?: string; GITHUB_BRANCH?: string;
  STORE?: string; STORE_DIR?: string; SITE_PASSWORD?: string; SESSION_SECRET?: string;
  [k: string]: string | undefined;
}

/**
 * The cloud store from the environment, always sealed with DATA_KEY (it throws without one: fail closed).
 * GitHub with GITHUB_TOKEN and GITHUB_REPO (Vercel) or GITHUB_REPOSITORY (set by Actions). STORE=local with STORE_DIR
 * runs against a folder instead, for trying the cloud path on a laptop.
 */
export function storeFromEnv(env: CloudEnv = process.env, fetchFn?: typeof fetch): SealedStore {
  const key = dataKey(env);
  if (env.STORE === 'local') {
    if (!env.STORE_DIR) throw new Error('STORE=local needs STORE_DIR');
    return new SealedStore(new LocalStore(env.STORE_DIR), key);
  }
  return new SealedStore(new GitHubStore(githubFromEnv(env, fetchFn)), key);
}

export function githubFromEnv(env: CloudEnv = process.env, fetchFn?: typeof fetch): GitHub {
  return new GitHub({ token: env.GITHUB_TOKEN ?? '', repo: env.GITHUB_REPO || env.GITHUB_REPOSITORY || '', fetchFn });
}

/** The sealed copy of the database kept in the Actions cache folder, for the restore that skips a download. */
export const cacheStore = (cacheDir: string, env: CloudEnv = process.env) => new SealedStore(new LocalStore(join(cacheDir, 'db')), dataKey(env));
