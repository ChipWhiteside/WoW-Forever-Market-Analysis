import type { DB } from '../store/db.ts';
import { setKv } from '../store/db.ts';
import type { Listing } from '../analysis/aggregate.ts';
import { chipHouses } from './houses.ts';
import { buildFlipInputs } from './inputs.ts';
import { runFlips, type FlipRunResult } from './run.ts';
import { persistFlips } from './persist.ts';

/** Where the engine gets current listings: the collector in the engine, raw snapshots in the CLI. */
export type ListingSource = (houseId: number, kind: 'auctions' | 'commodities') => Listing[];

/**
 * One flip run over the newest snapshot of Chip's houses: build, rank, store, and keep the closest calls.
 * Never throws: a failed run is stored as incomplete with its reason, so the page says so instead of showing
 * an old or partial list as if it were current.
 */
export function hourlyFlips(db: DB, source: ListingSource, now = Date.now(), log: (m: string) => void = () => {}): FlipRunResult | null {
  try {
    const listings = new Map<number, Listing[]>();
    for (const h of chipHouses(db)) {
      const ls = [...source(h.id, 'auctions'), ...source(h.id, 'commodities')];
      if (ls.length) listings.set(h.id, ls);
    }
    const res = runFlips(buildFlipInputs(db, listings, now));
    persistFlips(db, res, now);
    // Closest calls: held back candidates that would have made money per item, best first, one per item and family.
    const seen = new Set<string>();
    const closest = res.heldBack.filter(h => h.perItem != null && h.perItem > 0).sort((a, b) => b.perItem! - a.perItem!)
      .filter(h => { const k = `${h.family}:${h.itemId}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
    setKv(db, 'flip_held_back', JSON.stringify(closest));
    log(`flips: ${res.report.flips} ranked from ${res.report.recipesTried} recipes and ${res.report.items} items in ${res.report.ms} ms${res.report.complete ? '' : `, INCOMPLETE: ${res.report.incompleteReason}`}`);
    return res;
  } catch (e) {
    const msg = (e as Error).message;
    log(`flips: run failed: ${msg}`);
    db.prepare('INSERT OR REPLACE INTO flip_runs (at, data_at, ms, complete, report) VALUES (?, ?, 0, 0, ?)')
      .run(now, now, JSON.stringify({ at: now, dataAt: now, ms: 0, complete: false, incompleteReason: `run failed: ${msg}`, houses: [], items: 0, recipesTried: 0, flips: 0, byFamily: {}, heldBackByReason: {}, suspects: [msg] }));
    return null;
  }
}
