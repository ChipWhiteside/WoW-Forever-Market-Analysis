import { loadDotEnv } from '../config/env.ts';
import { BlizzardClient } from '../blizzard/client.ts';
import { LocalStore } from './localStore.ts';
import { SupabaseStore } from './supabaseStore.ts';
import type { BlobStore } from './store.ts';
import { cloudRun } from './run.ts';

/**
 * `npm run cloud:run`: one hourly cloud cycle. Configured by the environment:
 * SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_BUCKET (default gold-finder), BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET,
 * DISCORD_WEBHOOK_URL, DISCORD_DEV_WEBHOOK_URL, APP_URL, WAIT_FOR_PUBLISH_MIN (default 15), RAW_KEEP_DAYS (default 14).
 * STORE=local with STORE_DIR runs against a folder instead of Supabase. Exits 0 when the lock is held.
 */
export function storeFromEnv(env = process.env): BlobStore {
  if (env.STORE === 'local') {
    if (!env.STORE_DIR) throw new Error('STORE=local needs STORE_DIR');
    return new LocalStore(env.STORE_DIR);
  }
  return new SupabaseStore({ url: env.SUPABASE_URL ?? '', key: env.SUPABASE_SERVICE_KEY ?? '', bucket: env.SUPABASE_BUCKET || 'gold-finder' });
}

async function main() {
  loadDotEnv();
  const env = process.env;
  if (!env.BLIZZARD_CLIENT_ID || !env.BLIZZARD_CLIENT_SECRET) throw new Error('BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET are required');
  const wait = Number(env.WAIT_FOR_PUBLISH_MIN ?? 15);
  const keep = Number(env.RAW_KEEP_DAYS ?? 14);
  const r = await cloudRun({
    store: storeFromEnv(),
    client: new BlizzardClient(env.BLIZZARD_CLIENT_ID, env.BLIZZARD_CLIENT_SECRET, 'us'),
    webhookUrl: env.DISCORD_WEBHOOK_URL || null,
    devWebhookUrl: env.DISCORD_DEV_WEBHOOK_URL || null,
    appUrl: env.APP_URL || null,
    waitForPublishMin: Number.isFinite(wait) && wait >= 0 ? wait : 15,
    rawKeepDays: Number.isFinite(keep) && keep > 0 ? keep : 14,
    keepWorkDir: env.CLOUD_KEEP_WORKDIR === '1',
  });
  console.log(JSON.stringify({ status: r.status, refresh: r.refresh, ms: r.ms, waitedMs: r.waitedMs, bytesDown: r.bytesDown, bytesUp: r.bytesUp,
    dbBytes: r.dbBytes, rawPulled: r.rawPulled, rawPushed: r.rawPushed, rawPruned: r.rawPruned, daily: r.daily, ...(env.CLOUD_KEEP_WORKDIR === '1' ? { workDir: r.workDir } : {}) }));
}

main().catch(e => { console.error(e); process.exit(1); });
