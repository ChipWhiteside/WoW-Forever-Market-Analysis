/**
 * Phase 2 (docs/phase2-plan.md): where the engine's files live when it runs in the cloud. One small interface with two
 * implementations: a local folder (tests and local mode) and Supabase Storage over its REST API.
 */
export interface BlobInfo { key: string; size: number; etag: string | null; updatedAt: number | null }

export interface BlobStore {
  /** null when the object does not exist. */
  get(key: string): Promise<{ body: Uint8Array; etag: string | null } | null>;
  /** Only the ETag, cheap; null when missing. */
  head(key: string): Promise<{ etag: string | null; size: number } | null>;
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Objects whose key starts with prefix. */
  list(prefix: string): Promise<BlobInfo[]>;
  /**
   * Try to take the named lock for ttlMs. Returns a release function, or null when someone else holds an unexpired lock.
   * Holders must release; an expired lock may be taken over.
   */
  lock(name: string, ttlMs: number, owner: string): Promise<(() => Promise<void>) | null>;
}
