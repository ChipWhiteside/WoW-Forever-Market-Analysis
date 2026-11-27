import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, type DB } from '../store/db.ts';
import type { BlobInfo, BlobStore } from './store.ts';
import { newestDb, pullDb } from './layout.ts';

const { DatabaseSync } = await import('node:sqlite');

/**
 * The site's copies on Vercel (brief item 6). The newest database asset is downloaded into the function's temp folder
 * once per asset (its id is the ETag), so warm calls reuse it, and opened twice:
 * - `ro`, read only, for every GET;
 * - `rw`, only for dry runs: a write is tried inside a transaction that is always rolled back, so the site answers a
 *   refusal at once without ever changing its copy (src/cloud/inbox.ts). Dry runs are serialised.
 * The small JSON assets (results.json, ledger.json) are cached by ETag the same way.
 */
export interface SiteDb { key: string | null; etag: string | null; path: string; ro: DB; rw: DB }

const dbs = new WeakMap<BlobStore, SiteDb>();
const jsons = new WeakMap<BlobStore, Map<string, { etag: string | null; value: unknown }>>();
const queue = new WeakMap<SiteDb, Promise<unknown>>();

const removeDb = (p: string) => { for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); };

/** The site's database for this listing; downloads only when the newest database asset changed. */
export async function siteDb(store: BlobStore, listing: BlobInfo[], opts: { dir?: string } = {}): Promise<SiteDb> {
  const newest = newestDb(listing);
  const c = dbs.get(store);
  if (c && c.key === (newest?.key ?? null) && c.etag === (newest?.etag ?? null)) return c;
  const dir = opts.dir ?? join(tmpdir(), 'wowf-db');
  mkdirSync(dir, { recursive: true });
  const file = `site-${Date.now()}-${randomBytes(4).toString('hex')}.db`;
  // No database yet (before the first cycle): the empty schema.
  if (newest) await pullDb(store, newest.key, dir, file);
  openDb(dir, file).close(); // brings an older schema up to date, on this copy only
  const path = join(dir, file);
  const next: SiteDb = { key: newest?.key ?? null, etag: newest?.etag ?? null, path, ro: new DatabaseSync(path, { readOnly: true }), rw: new DatabaseSync(path) };
  if (c) { for (const d of [c.ro, c.rw]) { try { d.close(); } catch { /* closed */ } } removeDb(c.path); }
  dbs.set(store, next);
  return next;
}

/** Run fn on the writable connection inside a transaction that is always rolled back. One at a time. */
export function dryRun<T>(s: SiteDb, fn: (db: DB) => Promise<T>): Promise<T> {
  const prev = queue.get(s) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    s.rw.exec('BEGIN');
    try { return await fn(s.rw); } finally { s.rw.exec('ROLLBACK'); }
  });
  queue.set(s, run);
  return run;
}

/** A small JSON asset, downloaded again only when its ETag in the listing changed; null when it is not there. */
export async function cachedJson<T>(store: BlobStore, listing: BlobInfo[], key: string): Promise<T | null> {
  const o = listing.find(x => x.key === key);
  if (!o) return null;
  let m = jsons.get(store);
  if (!m) jsons.set(store, (m = new Map()));
  const hit = m.get(key);
  if (hit && o.etag !== null && hit.etag === o.etag) return hit.value as T;
  const got = await store.get(key);
  if (!got) return null;
  const value = JSON.parse(new TextDecoder().decode(got.body)) as T;
  m.set(key, { etag: o.etag, value });
  return value;
}
