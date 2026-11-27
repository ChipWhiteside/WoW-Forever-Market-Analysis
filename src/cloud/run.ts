/**
 * STUB (phase 2 items 4 to 6 agent). The real cloud cycle is built in parallel by another agent; the coordinator
 * replaces this file on merge. The Vercel handler (src/cloud/vercelHandler.ts) and api/index.ts import only
 * runCloudCycle and storeFromEnv from here.
 */
import type { BlobStore } from './store.ts';

export type CloudEnv = Record<string, string | undefined>;

/** One cloud cycle (docs/phase2-plan.md item 2). Takes the store lock itself and throws when the lock is held. */
export async function runCloudCycle(_store: BlobStore, _env: CloudEnv): Promise<{ status?: string; message?: string; errors?: string[] } | void> {
  throw new Error('runCloudCycle: not built yet');
}

/** The production BlobStore (Supabase Storage) built from the environment. */
export function storeFromEnv(_env: CloudEnv): BlobStore {
  throw new Error('storeFromEnv: not built yet');
}
