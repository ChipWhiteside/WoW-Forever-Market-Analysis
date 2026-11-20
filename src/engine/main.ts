import { loadConfig } from '../config/env.ts';
import { openDb } from '../store/db.ts';
import { BlizzardClient, sleep } from '../blizzard/client.ts';
import { Engine } from './engine.ts';
import { syncEgLink } from '../datasets/eglink.ts';
import { syncRecipes } from '../datasets/recipes.ts';
import { dailyMaintenance } from './daily.ts';
import { startServer } from '../server/server.ts';
import { rebuildIfRulesChanged } from './rebuild.ts';

const POLL_MS = 2 * 60_000;
let lastDailyFailure = 0;

async function main() {
  const cfg = loadConfig();
  const once = process.argv.includes('--once');
  const noServer = process.argv.includes('--no-server');
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  const db = openDb(cfg.dataDir);
  const client = new BlizzardClient(cfg.clientId, cfg.clientSecret, cfg.region);
  const engine = new Engine(client, db, { dataDir: cfg.dataDir, webhookUrl: cfg.discordWebhookUrl, devWebhookUrl: cfg.discordDevWebhookUrl, appUrl: `http://localhost:${cfg.port}`, log });
  log(`data in ${cfg.dataDir}`);

  if (!noServer && !once) await startServer({ db, engine, client, port: cfg.port, dataDir: cfg.dataDir, log });

  if (once) await engine.init();
  else await retry(() => engine.init(), 'house sync', log);

  // When the sale rules change, re-count every stored snapshot with them, so history is never thrown away.
  try { rebuildIfRulesChanged(db, log); } catch (e) { log(`history rebuild failed: ${(e as Error).message}`); }

  // Rebuild plays from the last snapshot right away, so a restart (or an update) never leaves the app
  // empty until the next hourly publish.
  try { await engine.detect(); } catch (e) { log(`startup detect failed: ${(e as Error).message}`); }

  // Each daily step stands alone, so one failing source never blocks the others or the backup.
  const daily = async () => {
    if (!engine.dailyDue()) return;
    const step = async (name: string, fn: () => Promise<string>) => {
      try { log(`${name}: ${await fn()}`); return true; } catch (e) { log(`${name} failed, will retry next round: ${(e as Error).message}`); return false; }
    };
    const results = [
      await step('eglink', async () => { const r = await syncEgLink(db, cfg.dataDir); return `${r.vendors} vendor rows, ${r.loot} loot rows, ${r.names} names, ${r.questItems} quest items from ${r.builds} builds`; }),
      await step('recipes', async () => { const r = await syncRecipes(client, db, cfg.dataDir, log); return `${r.recipes} recipes, ${r.withThresholds} with skill thresholds`; }),
      await step('vendor prices', async () => { const c = await engine.refreshCatalog(); return `${c.length} sell price changes`; }),
      await step('maintenance', async () => JSON.stringify(dailyMaintenance(db, cfg.dataDir))),
    ];
    // Mark done only when every step worked, otherwise the next round retries the whole set.
    if (results.every(Boolean)) engine.markDaily();
    else lastDailyFailure = Date.now();
  };
  // A dataset added by an update (trainers on November 20) fills on the first start, not up to a day later.
  const trainers = db.prepare('SELECT COUNT(*) AS n FROM trainer_spells').get() as { n: number };
  if (trainers.n === 0) {
    try { const r = await syncEgLink(db, cfg.dataDir); log(`eglink on start: ${r.trainerSpells} trainer recipes`); } catch (e) { log(`eglink on start failed: ${(e as Error).message}`); }
  }
  await daily();
  for (;;) {
    const started = Date.now();
    try { await engine.round(); } catch (e) { log(`round failed: ${(e as Error).message}`); }
    if (once) break;
    if (Date.now() - lastDailyFailure > 30 * 60_000) await daily();
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
