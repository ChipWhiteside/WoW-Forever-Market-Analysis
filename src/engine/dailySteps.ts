import type { DB } from '../store/db.ts';
import type { BlizzardClient } from '../blizzard/client.ts';
import type { Engine } from './engine.ts';
import { syncEgLink } from '../datasets/eglink.ts';
import { syncRecipes, summarizeRecipes, checkItemsAfterRefresh } from '../datasets/recipes.ts';
import { dailyMaintenance } from './daily.ts';

/**
 * The daily refresh, shared by the local engine (src/engine/main.ts) and the cloud cycle (src/cloud/run.ts).
 * Each step stands alone, so one failing source never blocks the others or the backup. Returns true only when every
 * step worked; the caller marks the day done (engine.markDaily) only then, so a failure retries the whole set.
 */
export async function runDailySteps(engine: Engine, db: DB, client: BlizzardClient, dataDir: string, log: (m: string) => void): Promise<boolean> {
  const step = async (name: string, fn: () => Promise<string>) => {
    try { log(`${name}: ${await fn()}`); return true; } catch (e) { log(`${name} failed, will retry next round: ${(e as Error).message}`); return false; }
  };
  const results = [
    await step('eglink', async () => { const r = await syncEgLink(db, dataDir); return `${r.vendors} vendor rows, ${r.loot} loot rows, ${r.names} names, ${r.questItems} quest items from ${r.builds} builds`; }),
    await step('recipes', async () => summarizeRecipes(await syncRecipes(client, db, dataDir, log))),
    await step('vendor prices', async () => { const c = await engine.refreshCatalog(); return `${c.length} sell price changes`; }),
    // After the price refresh, so a server hotfix to binding or sell price shows against ItemSparse the same day.
    await step('item check', async () => checkItemsAfterRefresh(db, dataDir, log, client)),
    await step('maintenance', async () => JSON.stringify(dailyMaintenance(db, dataDir))),
  ];
  return results.every(Boolean);
}

/** Whether a dataset added by an update still has to fill on this start (see startupFills). */
export function startupFillsNeeded(engine: Engine, db: DB): { trainers: boolean; gamedata: boolean } {
  const trainers = (db.prepare('SELECT COUNT(*) AS n FROM trainer_spells').get() as { n: number }).n === 0;
  const gamedata = !db.prepare(`SELECT 1 AS ok FROM datasets WHERE name = 'gamedata'`).get() && !engine.dailyDue();
  return { trainers, gamedata };
}

/**
 * A dataset added by an update (trainers on November 20) fills on the first start, not up to a day later. The game
 * tables and the rebuilt recipes (flip plan section 4) fill on the first start after the update too. When the daily
 * refresh is due anyway, it does this itself.
 */
export async function startupFills(engine: Engine, db: DB, client: BlizzardClient, dataDir: string, log: (m: string) => void): Promise<void> {
  const need = startupFillsNeeded(engine, db);
  if (need.trainers) {
    try { const r = await syncEgLink(db, dataDir); log(`eglink on start: ${r.trainerSpells} trainer recipes`); } catch (e) { log(`eglink on start failed: ${(e as Error).message}`); }
  }
  if (need.gamedata) {
    try { log(`recipes on start: ${summarizeRecipes(await syncRecipes(client, db, dataDir, log))}`); } catch (e) { log(`recipes on start failed: ${(e as Error).message}`); }
  }
}
