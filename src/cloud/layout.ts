import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobStore } from './store.ts';

/**
 * Where the engine's files live in the blob store (docs/phase2-plan.md). The cloud cycle (src/cloud/run.ts) writes
 * them; the site reads them.
 *
 * - `wowf.db.gz`   the engine database, gzipped. Gzipped because the raw file is over 100 MB and Supabase's free plan
 *                  is believed to cap one upload at 50 MB; gzip brings Chip's database to about 33 MB.
 * - `results.json` the /api/flips payload, exactly what GET /api/flips answers.
 * - `raw/<day>/<house>-<kind>-<publishedAt>.json.gz`  raw snapshots, the same layout as DATA_DIR/raw.
 * - `datasets/<path>.gz`  the static dataset caches (wago, EG Link), the same layout as DATA_DIR/datasets.
 * - `locks/<name>.json`   lock objects (src/cloud/store.ts).
 */
export const DB_KEY = 'wowf.db.gz';
export const RESULTS_KEY = 'results.json';
export const RAW_PREFIX = 'raw/';
export const DATASETS_PREFIX = 'datasets/';
/** The one lock every writer takes: the hourly cycle and the site's writes. */
export const ENGINE_LOCK = 'engine';

/** Download the database into dir/wowf.db. Returns its ETag, or null when the store has none yet (nothing written). */
export async function pullDb(store: BlobStore, dir: string): Promise<{ etag: string | null; bytes: number } | null> {
  const got = await store.get(DB_KEY);
  if (!got) return null;
  mkdirSync(dir, { recursive: true });
  for (const f of ['wowf.db', 'wowf.db-wal', 'wowf.db-shm']) rmSync(join(dir, f), { force: true });
  writeFileSync(join(dir, 'wowf.db'), gunzipSync(got.body));
  return { etag: got.etag, bytes: got.body.length };
}

/**
 * Upload dir/wowf.db. The caller must have closed the database (or checkpointed it) so the file holds every write.
 * Returns the bytes sent.
 */
export async function pushDb(store: BlobStore, dir: string): Promise<number> {
  const body = gzipSync(readFileSync(join(dir, 'wowf.db')), { level: 6 });
  await store.put(DB_KEY, body, 'application/gzip');
  return body.length;
}
