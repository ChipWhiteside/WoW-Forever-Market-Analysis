import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { BlobInfo, BlobStore } from './store.ts';

/**
 * The blob store as a plain folder: local mode, the Actions cache folder and tests. Keys are slash separated paths
 * under the root. The ETag is size and modification time; every put renames a new file in, so it changes on each put.
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
    return { body: new Uint8Array(readFileSync(p)), etag: tag(statSync(p)) };
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
        out.push({ key, size: st.size, etag: tag(st), updatedAt: st.mtimeMs });
      }
    };
    walk(this.root, '');
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}

const tag = (st: { size: number; mtimeMs: number; ino: number }) => `${st.size}-${st.mtimeMs}-${st.ino}`;
