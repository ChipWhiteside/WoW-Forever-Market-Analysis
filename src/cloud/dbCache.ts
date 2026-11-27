import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, type DB } from '../store/db.ts';
import type { BlobStore } from './store.ts';

const { DatabaseSync } = await import('node:sqlite');

/**
 * The site's database on Vercel (docs/phase2-plan.md item 4). The engine's wowf.db lives in the BlobStore. Reads use
 * a copy in the function's temp folder, downloaded again only when the stored ETag changes, opened read only.
 * Writes take the store lock, download the newest copy, apply, upload and release.
 */
export const DB_KEY = 'wowf.db';
/** The lock the hourly cloud run also takes, so a write never lands in the middle of a cycle. */
export const DB_LOCK = 'wowf';
export const WRITE_LOCK_TTL_MS = 120_000;

export class DbLockHeldError extends Error {
  constructor() { super('the hourly run or another write holds the lock; try again in a minute'); this.name = 'DbLockHeldError'; }
}

interface Cached { etag: string | null; db: DB; path: string }
const cache = new WeakMap<BlobStore, Cached>();
const dirOf = (dir?: string) => { const d = dir ?? join(tmpdir(), 'wowf-db'); mkdirSync(d, { recursive: true }); return d; };
const tmpName = (dir: string, tag: string) => join(dir, `${tag}-${Date.now()}-${randomBytes(4).toString('hex')}.db`);
const removeDb = (p: string) => { for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); };

/**
 * Write the stored bytes (or nothing, for a new database) to `path` and bring the schema up to date there. The
 * migration runs on this temp copy only; a read never uploads.
 */
function materialise(path: string, body: Uint8Array | null): void {
  if (body) writeFileSync(path, body);
  const parts = path.split('/'); const file = parts.pop()!;
  openDb(parts.join('/'), file).close();
}

/** The read only database for GETs. Downloads only when the stored ETag differs from the cached copy's. */
export async function getDb(store: BlobStore, opts: { dir?: string } = {}): Promise<{ db: DB; etag: string | null; fresh: boolean }> {
  const head = await store.head(DB_KEY);
  const etag = head?.etag ?? null;
  const c = cache.get(store);
  // A store without ETags always downloads; a missing database is the empty schema until the first cloud run.
  if (c && etag !== null && c.etag === etag) return { db: c.db, etag, fresh: false };
  const got = head ? await store.get(DB_KEY) : null;
  const path = tmpName(dirOf(opts.dir), 'read');
  materialise(path, got?.body ?? null);
  const db = new DatabaseSync(path, { readOnly: true });
  if (c) { try { c.db.close(); } catch { /* already closed */ } removeDb(c.path); }
  cache.set(store, { etag: got?.etag ?? etag, db, path });
  return { db, etag: got?.etag ?? etag, fresh: true };
}

/** Forget the cached read copy, so the next GET downloads. */
export function invalidateDb(store: BlobStore): void {
  const c = cache.get(store);
  if (!c) return;
  cache.delete(store);
  try { c.db.close(); } catch { /* fine */ }
  removeDb(c.path);
}

/**
 * Run `fn` on a writable copy of the newest database under the store lock. When it returns commit true the database
 * goes back to the store. Throws DbLockHeldError when someone else holds the lock.
 */
export async function withWriteDb<T>(store: BlobStore, owner: string, fn: (db: DB) => Promise<{ commit: boolean; value: T }>, opts: { dir?: string } = {}): Promise<T> {
  const release = await store.lock(DB_LOCK, WRITE_LOCK_TTL_MS, owner);
  if (!release) throw new DbLockHeldError();
  const path = tmpName(dirOf(opts.dir), 'write');
  try {
    const got = await store.get(DB_KEY);
    materialise(path, got?.body ?? null);
    const parts = path.split('/'); const file = parts.pop()!;
    const db = openDb(parts.join('/'), file);
    let r: { commit: boolean; value: T };
    try { r = await fn(db); } finally { db.close(); } // close checkpoints the WAL into the main file
    if (r.commit) {
      await store.put(DB_KEY, new Uint8Array(readFileSync(path)), 'application/vnd.sqlite3');
      invalidateDb(store);
    }
    return r.value;
  } finally {
    removeDb(path);
    await release();
  }
}
