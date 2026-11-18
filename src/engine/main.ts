import { loadConfig } from '../config/env.ts';
import { openDb } from '../store/db.ts';
import { BlizzardClient, sleep } from '../blizzard/client.ts';
import { Engine } from './engine.ts';
import { syncEgLink } from '../datasets/eglink.ts';
import { syncRecipes } from '../datasets/recipes.ts';
import { dailyMaintenance } from './daily.ts';
import { startServer } from '../server/server.ts';

const POLL_MS = 2 * 60_000;

async function main() {
  const cfg = loadConfig();
  const once = process.argv.includes('--once');
  const noServer = process.argv.includes('--no-server');
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  const db = openDb(cfg.dataDir);
  const client = new BlizzardClient(cfg.clientId, cfg.clientSecret, cfg.region);
  const engine = new Engine(client, db, { dataDir: cfg.dataDir, webhookUrl: cfg.discordWebhookUrl, appUrl: `http://localhost:${cfg.port}`, log });
  log(`data in ${cfg.dataDir}`);

  if (!noServer && !once) await startServer({ db, engine, client, port: cfg.port, dataDir: cfg.dataDir, log });

  await retry(() => engine.init(), 'house sync', log);

  const daily = async () => {
    if (!engine.dailyDue()) return;
    try {
      const eg = await syncEgLink(db, cfg.dataDir, () => {});
      log(`eglink: ${eg.vendors} vendor rows, ${eg.loot} loot rows, ${eg.names} names from ${eg.builds} builds`);
      const rc = await syncRecipes(client, db, cfg.dataDir, log);
      log(`recipes: ${rc.recipes} recipes, ${rc.withThresholds} with skill thresholds`);
      const changes = await engine.refreshCatalog();
      if (changes.length) log(`vendor sell price changed on ${changes.length} items`);
      log(`maintenance: ${JSON.stringify(dailyMaintenance(db, cfg.dataDir))}`);
      engine.markDaily();
    } catch (e) {
      log(`daily job failed, will retry next round: ${(e as Error).message}`);
    }
  };

  await daily();
  for (;;) {
    const started = Date.now();
    try { await engine.round(); } catch (e) { log(`round failed: ${(e as Error).message}`); }
    if (once) break;
    await daily();
    await sleep(Math.max(5_000, POLL_MS - (Date.now() - started)));
  }
  db.close();
}

async function retry(fn: () => Promise<void>, what: string, log: (m: string) => void) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      log(`${what} failed (${(e as Error).message}), retrying in ${Math.min(10, 1 + i)} min`);
      await sleep(Math.min(10, 1 + i) * 60_000);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
