import { createHash } from 'node:crypto';
import type { BlobStore, BlobInfo } from '../src/cloud/store.ts';

/** A BlobStore in memory for tests: content ETags, a lock with expiry, and counters to see what was called. */
export class MemoryStore implements BlobStore {
  objects = new Map<string, { body: Uint8Array; etag: string; updatedAt: number }>();
  locks = new Map<string, { owner: string; until: number }>();
  calls = { get: 0, head: 0, put: 0 };
  now = () => Date.now();

  async get(key: string) { this.calls.get++; const o = this.objects.get(key); return o ? { body: new Uint8Array(o.body), etag: o.etag } : null; }
  async head(key: string) { this.calls.head++; const o = this.objects.get(key); return o ? { etag: o.etag, size: o.body.length } : null; }
  async put(key: string, body: Uint8Array) {
    this.calls.put++;
    this.objects.set(key, { body: new Uint8Array(body), etag: `"${createHash('md5').update(body).digest('hex')}"`, updatedAt: this.now() });
  }
  async delete(key: string) { this.objects.delete(key); }
  async list(prefix: string): Promise<BlobInfo[]> {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.length, etag: o.etag, updatedAt: o.updatedAt }));
  }
  async lock(name: string, ttlMs: number, owner: string) {
    const held = this.locks.get(name);
    if (held && held.until > this.now()) return null;
    this.locks.set(name, { owner, until: this.now() + ttlMs });
    return async () => { if (this.locks.get(name)?.owner === owner) this.locks.delete(name); };
  }
}
