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
  /** Added for the cloud cycle: delete many keys in one call where the backend can. Optional; falls back to delete. */
  deleteMany?(keys: string[]): Promise<void>;
  /** Added for the cloud cycle: who holds the named lock and until when, null when free. Optional, for messages only. */
  lockHolder?(name: string): Promise<LockRecord | null>;
}

/** What a lock object holds. `token` is unique per acquisition, so a release never frees a lock taken over since. */
export interface LockRecord { owner: string; token: string; expiresAt: number }

/** Where lock objects live in the store. Both implementations use it. */
export const lockKey = (name: string) => `locks/${name}.json`;
