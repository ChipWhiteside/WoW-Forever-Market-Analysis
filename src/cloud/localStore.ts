import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { lockKey, type BlobInfo, type BlobStore, type LockRecord } from './store.ts';

/**
 * The blob store as a plain folder: tests and local mode (STORE=local, STORE_DIR). Keys are slash separated paths
 * under the root. The ETag is the MD5 of the content, so it changes exactly when the content does.
 */
export class LocalStore implements BlobStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true }); }

  private path(key: string): string {
    if (!key || key.startsWith('/') || key.split('/').some(p => p === '..' || p === '')) throw new Error(`bad key: ${key}`);
    return join(this.root, ...key.split('/'));
  }

  async get(key: string) {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    const body = new Uint8Array(readFileSync(p));
    return { body, etag: md5(body) };
  }

  async head(key: string) {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    const body = readFileSync(p);
    return { etag: md5(body), size: body.length };
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    // Write then rename, so a reader never sees half a file.
    const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, p);
  }

  async delete(key: string): Promise<void> { rmSync(this.path(key), { force: true }); }

  async deleteMany(keys: string[]): Promise<void> { for (const k of keys) await this.delete(k); }

  async list(prefix: string): Promise<BlobInfo[]> {
    const out: BlobInfo[] = [];
    const walk = (dir: string, rel: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const key = rel ? `${rel}/${name}` : name;
        const st = statSync(full);
        if (st.isDirectory()) { if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) walk(full, key); continue; }
        if (name.endsWith('.tmp') || !key.startsWith(prefix)) continue;
        out.push({ key, size: st.size, etag: null, updatedAt: st.mtimeMs });
      }
    };
    walk(this.root, '');
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async lockHolder(name: string): Promise<LockRecord | null> {
    try { return JSON.parse(readFileSync(this.path(lockKey(name)), 'utf8')) as LockRecord; } catch { return null; }
  }

  /** A lock file created exclusively ('wx'), holding owner and expiry. An expired or unreadable one is taken over. */
  async lock(name: string, ttlMs: number, owner: string): Promise<(() => Promise<void>) | null> {
    const p = this.path(lockKey(name));
    mkdirSync(dirname(p), { recursive: true });
    const rec: LockRecord = { owner, token: randomUUID(), expiresAt: Date.now() + ttlMs };
    for (let i = 0; i < 3; i++) {
      try {
        writeFileSync(p, JSON.stringify(rec), { flag: 'wx' });
        return async () => {
          const cur = await this.lockHolder(name);
          if (cur?.token === rec.token) rmSync(p, { force: true });
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const cur = await this.lockHolder(name);
        if (cur && Number.isFinite(cur.expiresAt) && cur.expiresAt > Date.now()) return null;
        rmSync(p, { force: true }); // expired or unreadable: take it over; the next 'wx' decides who wins
      }
    }
    return null;
  }
}

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
