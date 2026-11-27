/**
 * Phase 2 (docs/phase2-plan.md): where the cloud keeps its files. One small interface with two implementations: a
 * local folder (local mode, the Actions cache folder, tests) and GitHub (release assets plus inbox files on a branch,
 * src/cloud/githubStore.ts). Every cloud object goes through SealedStore (src/cloud/crypto.ts).
 *
 * There is no lock: the Actions concurrency group runs one cycle at a time, and the site never writes the database.
 */
export interface BlobInfo {
  key: string;
  size: number;
  /** Changes whenever the content does: an MD5 for the folder, the asset id or the blob sha on GitHub. */
  etag: string | null;
  updatedAt: number | null;
}

export interface BlobStore {
  /** null when the object does not exist. */
  get(key: string): Promise<{ body: Uint8Array; etag: string | null } | null>;
  /** Create or replace. */
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** Deleting a missing key is fine. */
  delete(key: string): Promise<void>;
  /** Objects whose key starts with prefix, sorted by key. */
  list(prefix: string): Promise<BlobInfo[]>;
}
