import { join, resolve } from 'node:path';
import { loadDotEnv } from '../config/env.ts';
import { BlizzardClient } from '../blizzard/client.ts';
import { storeFromEnv, cacheStore } from './layout.ts';
import { cloudRun } from './run.ts';

/**
 * `npm run cloud:run`: one hourly cloud cycle (.github/workflows/collect.yml). Configured by the environment:
 * DATA_KEY (required: everything stored is sealed with it), GITHUB_TOKEN and GITHUB_REPOSITORY (set by Actions),
 * BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET, DISCORD_WEBHOOK_URL, DISCORD_DEV_WEBHOOK_URL, APP_URL,
 * WAIT_FOR_PUBLISH_MIN (default 15; the workflow sets 0 for a Refresh), CLOUD_CACHE_DIR (default .cloud-cache, the
 * folder the Actions cache saves and restores). STORE=local with STORE_DIR uses a folder in place of GitHub.
 */
async function main() {
  loadDotEnv();
  const env = process.env;
  if (!env.BLIZZARD_CLIENT_ID || !env.BLIZZARD_CLIENT_SECRET) throw new Error('BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET are required');
  const wait = Number(env.WAIT_FOR_PUBLISH_MIN ?? 15);
  const cacheDir = resolve(env.CLOUD_CACHE_DIR || '.cloud-cache');
  const r = await cloudRun({
    remote: storeFromEnv(env),
    cache: cacheStore(cacheDir, env),
    dataDir: join(cacheDir, 'data'),
    client: new BlizzardClient(env.BLIZZARD_CLIENT_ID, env.BLIZZARD_CLIENT_SECRET, 'us'),
    webhookUrl: env.DISCORD_WEBHOOK_URL || null,
    devWebhookUrl: env.DISCORD_DEV_WEBHOOK_URL || null,
    appUrl: env.APP_URL || null,
    waitForPublishMin: Number.isFinite(wait) && wait >= 0 ? wait : 15,
  });
  const { message: _m, publishes: _p, ...summary } = r;
  console.log(JSON.stringify(summary));
}

main().catch(e => { console.error(e); process.exit(1); });
