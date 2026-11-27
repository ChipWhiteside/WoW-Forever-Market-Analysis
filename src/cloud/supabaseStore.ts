import { randomUUID } from 'node:crypto';
import { lockKey, type BlobInfo, type BlobStore, type LockRecord } from './store.ts';

/**
 * The blob store on Supabase Storage, over its REST API with fetch only (no SDK). One bucket.
 *
 * Endpoints, read from supabase/storage-js (src/packages/StorageFileApi.ts) on November 27, 2026. The Supabase docs
 * site itself could not be reached from the build session, so these are confirmed against the client library, not
 * against a live project yet (docs/verification.md row C1):
 * - download  GET    {url}/storage/v1/object/{bucket}/{path}
 * - exists    HEAD   {url}/storage/v1/object/{bucket}/{path}         (400 or 404 means missing)
 * - upload    POST   {url}/storage/v1/object/{bucket}/{path}         raw body, headers content-type, cache-control, x-upsert
 * - remove    DELETE {url}/storage/v1/object/{bucket}                JSON { prefixes: [paths] }
 * - list      POST   {url}/storage/v1/object/list/{bucket}           JSON { prefix, limit, offset, sortBy }; one folder level,
 *             folders come back with id null
 * Every call sends the service key as both `apikey` and `Authorization: Bearer`.
 *
 * Assumptions not yet run against a real project (each is handled both ways):
 * - A missing object answers 404, or 400 with a JSON body whose statusCode is "404" (older storage servers).
 * - Uploading over an existing object with x-upsert false answers 409, or 400 with statusCode "409" / error "Duplicate".
 */
export interface SupabaseStoreOptions { url: string; key: string; bucket: string; fetchFn?: typeof fetch }

export class SupabaseStore implements BlobStore {
  private base: string;
  private fetchFn: typeof fetch;
  constructor(private opts: SupabaseStoreOptions) {
    if (!opts.url || !opts.key || !opts.bucket) throw new Error('SupabaseStore needs SUPABASE_URL, SUPABASE_SERVICE_KEY and a bucket');
    this.base = `${opts.url.replace(/\/+$/, '')}/storage/v1`;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.opts.key, Authorization: `Bearer ${this.opts.key}`, ...extra };
  }

  private objectUrl(key: string): string {
    if (!key || key.startsWith('/')) throw new Error(`bad key: ${key}`);
    return `${this.base}/object/${encodeURIComponent(this.opts.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async get(key: string) {
    const res = await this.fetchFn(this.objectUrl(key), { method: 'GET', headers: this.headers() });
    if (res.ok) return { body: new Uint8Array(await res.arrayBuffer()), etag: res.headers.get('etag') };
    if (await isMissing(res)) return null;
    throw await failure('GET', key, res);
  }

  async head(key: string) {
    const res = await this.fetchFn(this.objectUrl(key), { method: 'HEAD', headers: this.headers() });
    if (res.ok) return { etag: res.headers.get('etag'), size: Number(res.headers.get('content-length') ?? 0) };
    // A HEAD has no body: 400 and 404 both mean missing, as storage-js exists() reads them.
    if (res.status === 404 || res.status === 400) return null;
    throw await failure('HEAD', key, res);
  }

  private async upload(key: string, body: Uint8Array, contentType: string, upsert: boolean): Promise<Response> {
    return this.fetchFn(this.objectUrl(key), {
      method: 'POST',
      headers: this.headers({ 'content-type': contentType, 'cache-control': 'max-age=0', 'x-upsert': String(upsert) }),
      body: body as unknown as BodyInit,
    });
  }

  async put(key: string, body: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    const res = await this.upload(key, body, contentType, true);
    if (!res.ok) throw await failure('PUT', key, res);
    await res.body?.cancel();
  }

  async delete(key: string): Promise<void> { await this.deleteMany([key]); }

  async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const res = await this.fetchFn(`${this.base}/object/${encodeURIComponent(this.opts.bucket)}`, {
        method: 'DELETE', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ prefixes: chunk }),
      });
      if (!res.ok && !(await isMissing(res))) throw await failure('DELETE', chunk[0]!, res);
      await res.body?.cancel().catch(() => {});
    }
  }

  /** Every object whose key starts with prefix. The API lists one folder at a time, so this walks into folders. */
  async list(prefix: string): Promise<BlobInfo[]> {
    const out: BlobInfo[] = [];
    const cut = prefix.lastIndexOf('/');
    const walk = async (folder: string) => {
      for (let offset = 0; ; offset += 1000) {
        const res = await this.fetchFn(`${this.base}/object/list/${encodeURIComponent(this.opts.bucket)}`, {
          method: 'POST', headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ prefix: folder, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
        });
        if (!res.ok) throw await failure('LIST', folder || '/', res);
        const rows = await res.json() as Array<{ name: string; id: string | null; updated_at?: string | null; metadata?: { size?: number; eTag?: string } | null }>;
        for (const r of rows) {
          const key = folder ? `${folder}/${r.name}` : r.name;
          if (r.id === null) { if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) await walk(key); continue; }
          if (!key.startsWith(prefix)) continue;
          out.push({ key, size: Number(r.metadata?.size ?? 0), etag: r.metadata?.eTag ?? null, updatedAt: r.updated_at ? Date.parse(r.updated_at) : null });
        }
        if (rows.length < 1000) break;
      }
    };
    await walk(cut === -1 ? '' : prefix.slice(0, cut));
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async lockHolder(name: string): Promise<LockRecord | null> {
    const got = await this.get(lockKey(name));
    if (!got) return null;
    try { return JSON.parse(new TextDecoder().decode(got.body)) as LockRecord; } catch { return null; }
  }

  /**
   * The lock is an object created with x-upsert false, so only one creator wins. It holds owner, a token and an
   * expiry. An expired (or unreadable) lock is deleted and created again; the winner reads it back and checks its own
   * token, so two processes taking over the same expired lock at once end with one holder in all but a narrow race
   * (delete, create and read back interleaving exactly), which the hourly job plus a few site writes never come near.
   */
  async lock(name: string, ttlMs: number, owner: string): Promise<(() => Promise<void>) | null> {
    const key = lockKey(name);
    const rec: LockRecord = { owner, token: randomUUID(), expiresAt: Date.now() + ttlMs };
    const body = new TextEncoder().encode(JSON.stringify(rec));
    for (let i = 0; i < 2; i++) {
      const res = await this.upload(key, body, 'application/json', false);
      if (res.ok) {
        await res.body?.cancel();
        const back = await this.lockHolder(name);
        if (back?.token !== rec.token) return null;
        return async () => {
          const cur = await this.lockHolder(name);
          if (cur?.token === rec.token) await this.delete(key);
        };
      }
      if (!(await isConflict(res))) throw await failure('LOCK', key, res);
      const cur = await this.lockHolder(name);
      if (cur && Number.isFinite(cur.expiresAt) && cur.expiresAt > Date.now()) return null;
      await this.delete(key); // expired or unreadable: take it over
    }
    return null;
  }
}

async function errorBody(res: Response): Promise<{ statusCode?: string | number; error?: string; message?: string; text: string }> {
  const text = await res.text().catch(() => '');
  try { return { ...(JSON.parse(text) as object), text }; } catch { return { text }; }
}

/** 404, or 400 carrying statusCode 404 / not_found in its body. Consumes the body. */
async function isMissing(res: Response): Promise<boolean> {
  if (res.status === 404) { await res.body?.cancel().catch(() => {}); return true; }
  if (res.status !== 400) return false;
  const b = await errorBody(res);
  return String(b.statusCode) === '404' || /not.?found/i.test(String(b.error ?? '')) || /not found/i.test(String(b.message ?? ''));
}

/** 409, or 400 carrying statusCode 409 / Duplicate in its body. Consumes the body. */
async function isConflict(res: Response): Promise<boolean> {
  if (res.status === 409) { await res.body?.cancel().catch(() => {}); return true; }
  if (res.status !== 400) return false;
  const b = await errorBody(res);
  return String(b.statusCode) === '409' || /duplicate/i.test(String(b.error ?? '')) || /already exists/i.test(String(b.message ?? ''));
}

async function failure(op: string, key: string, res: Response): Promise<Error> {
  const text = res.bodyUsed ? '' : (await res.text().catch(() => '')).slice(0, 200);
  return new Error(`Supabase Storage ${op} ${key} returned ${res.status}${text ? `: ${text}` : ''}`);
}
