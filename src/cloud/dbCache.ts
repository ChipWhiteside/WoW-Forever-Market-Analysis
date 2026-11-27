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
 *
 * Vercel can run several requests at once on one instance, so each copy counts the requests using it. When a newer
 * asset arrives the old copy stays open until its last request ends, then it is closed and removed (useSiteDb).
 */
export interface SiteDb { key: string | null; etag: string | null; path: string; ro: DB; rw: DB }
interface Held extends SiteDb { id: string; users: number; stale: boolean }

const dbs = new WeakMap<BlobStore, Held>();
const loading = new WeakMap<BlobStore, { id: string; p: Promise<Held> }>();
const jsons = new WeakMap<BlobStore, Map<string, { etag: string | null; value: unknown }>>();
const queue = new WeakMap<SiteDb, Promise<unknown>>();

const removeDb = (p: string) => { for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); };
function close(h: Held) { for (const d of [h.ro, h.rw]) { try { d.close(); } catch { /* closed */ } } removeDb(h.path); }

async function download(store: BlobStore, newest: BlobInfo | null, id: string, dir: string): Promise<Held> {
  mkdirSync(dir, { recursive: true });
  const file = `site-${Date.now()}-${randomBytes(4).toString('hex')}.db`;
  // No database yet (before the first cycle): the empty schema.
  if (newest) await pullDb(store, newest.key, dir, file);
  openDb(dir, file).close(); // brings an older schema up to date, on this copy only
  const path = join(dir, file);
  return { id, key: newest?.key ?? null, etag: newest?.etag ?? null, path, ro: new DatabaseSync(path, { readOnly: true }), rw: new DatabaseSync(path), users: 0, stale: false };
}

/** The copy for this listing, already counted as in use. Downloads only when the newest database asset changed. */
async function acquire(store: BlobStore, listing: BlobInfo[], dir: string): Promise<Held> {
  const newest = newestDb(listing);
  const id = `${newest?.key ?? ''}|${newest?.etag ?? ''}`;
  for (;;) {
    const c = dbs.get(store);
    if (c && c.id === id) { c.users++; return c; }
    const l = loading.get(store);
    if (l && l.id === id) { await l.p; continue; } // another request is downloading this one
    const p = download(store, newest, id, dir);
    loading.set(store, { id, p });
    let next: Held;
    try { next = await p; } finally { if (loading.get(store)?.p === p) loading.delete(store); }
    const old = dbs.get(store);
    dbs.set(store, next);
    if (old) { old.stale = true; if (old.users === 0) close(old); }
    next.users++;
    return next;
  }
}

/** Run fn on the site's database for this listing. Its copy stays open until fn ends, even when a newer one arrives. */
export async function useSiteDb<T>(store: BlobStore, listing: BlobInfo[], fn: (s: SiteDb) => Promise<T>, opts: { dir?: string } = {}): Promise<T> {
  const h = await acquire(store, listing, opts.dir ?? join(tmpdir(), 'wowf-db'));
  try { return await fn(h); } finally { if (--h.users === 0 && h.stale) close(h); }
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
