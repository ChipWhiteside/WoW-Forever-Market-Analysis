import { loadConfig } from '../config/env.ts';
import { openDb } from '../store/db.ts';
import { BlizzardClient, sleep } from '../blizzard/client.ts';
import { Engine } from './engine.ts';
import { runDailySteps, startupFills } from './dailySteps.ts';
import { startServer } from '../server/server.ts';
import { rebuildIfRulesChanged } from './rebuild.ts';
import { takeInstanceLock } from './instanceLock.ts';

const POLL_MS = 2 * 60_000;
let lastDailyFailure = 0;

async function main() {
  const cfg = loadConfig();
  const once = process.argv.includes('--once');
  const noServer = process.argv.includes('--no-server');
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  const db = openDb(cfg.dataDir);
  // One engine per data folder sends alerts. A second one (npm run once, a second --no-server run) still collects.
  const lock = takeInstanceLock(cfg.dataDir);
  if (lock.held) { process.on('exit', lock.release); for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { lock.release(); process.exit(0); }); }
  else log(`WARNING: another engine${lock.ownerPid ? ` (process ${lock.ownerPid})` : ''} already runs on this data folder. This one collects but sends no Discord alerts.`);
  const client = new BlizzardClient(cfg.clientId, cfg.clientSecret, cfg.region);
  const engine = new Engine(client, db, { dataDir: cfg.dataDir, webhookUrl: lock.held ? cfg.discordWebhookUrl : null, devWebhookUrl: lock.held ? cfg.discordDevWebhookUrl : null, appUrl: `http://localhost:${cfg.port}`, log });
  log(`data in ${cfg.dataDir}`);

  if (!noServer && !once) await startServer({ db, engine, client, port: cfg.port, dataDir: cfg.dataDir, log });

  if (once) await engine.init();
  else await retry(() => engine.init(), 'house sync', log);

  // When the sale rules change, re-count every stored snapshot with them, so history is never thrown away.
  try { rebuildIfRulesChanged(db, log); } catch (e) { log(`history rebuild failed: ${(e as Error).message}`); }

  // Rebuild plays from the last snapshot right away, so a restart (or an update) never leaves the app
  // empty until the next hourly publish.
  try { await engine.detect(); } catch (e) { log(`startup detect failed: ${(e as Error).message}`); }

  // Each daily step stands alone, so one failing source never blocks the others or the backup (src/engine/dailySteps.ts).
  const daily = async () => {
    if (!engine.dailyDue()) return;
    // Mark done only when every step worked, otherwise the next round retries the whole set.
    if (await runDailySteps(engine, db, client, cfg.dataDir, log)) engine.markDaily();
    else lastDailyFailure = Date.now();
  };
  // Datasets added by an update fill on the first start, not up to a day later.
  await startupFills(engine, db, client, cfg.dataDir, log);
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
