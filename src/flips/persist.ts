import { type DB, tx } from '../store/db.ts';
import { FADING_SHARE } from '../rules/thresholds.ts';
import type { FlipRunResult } from './run.ts';

/**
 * Store one run. Every run gets a flip_runs row with its report. A complete run then updates the list: a key seen
 * for the first time (or back after it was gone) is new, a repeat is live, a repeat whose expected profit fell by a
 * quarter is fading, and a key that did not come back is gone (kept 24 hours, like plays). Each flip on the list gets
 * a flip_history row keyed by its data hour (the publish it read, not the run time: a rerun on the same publish updates
 * the row), which feeds "new this hour" and "open N of the last 72 hours". An incomplete run marks every listed flip gone.
 */
export function persistFlips(db: DB, result: FlipRunResult, now = Date.now()): { created: string[]; gone: string[] } {
  const created: string[] = [], gone: string[] = [];
  tx(db, () => {
    db.prepare('INSERT OR REPLACE INTO flip_runs (at, data_at, ms, complete, report) VALUES (?, ?, ?, ?, ?)')
      .run(now, result.report.dataAt, result.report.ms, result.report.complete ? 1 : 0, JSON.stringify(result.report));
    // An incomplete run marks every flip not already gone as gone, so an old list never shows as current next to the
    // incomplete chip (coordinator decision, system review round 1). Card history stays in flip_history.
    if (!result.report.complete) {
      const gone1 = db.prepare(`UPDATE flips SET state = 'gone', gone_at = ?, rank = NULL WHERE key = ?`);
      for (const r of db.prepare(`SELECT key FROM flips WHERE state != 'gone'`).all() as Array<{ key: string }>) { gone1.run(now, r.key); gone.push(r.key); }
      return;
    }
    const get = db.prepare('SELECT state, expected_profit FROM flips WHERE key = ?');
    const ins = db.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, recipe_id, state, rank, expected_profit, risk, detail, first_seen, last_seen, data_at, gone_at)
      VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, NULL)`);
    const upd = db.prepare(`UPDATE flips SET kind = ?, family = ?, house_id = ?, item_id = ?, recipe_id = ?, state = ?, rank = ?, expected_profit = ?, risk = ?, detail = ?,
      first_seen = CASE WHEN state = 'gone' THEN ? ELSE first_seen END, last_seen = ?, data_at = ?, gone_at = NULL WHERE key = ?`);
    const hist = db.prepare('INSERT OR REPLACE INTO flip_history (at, key, expected_profit, per_item, units) VALUES (?, ?, ?, ?, ?)');
    for (const f of result.flips) {
      const prev = get.get(f.key) as { state: string; expected_profit: number } | undefined;
      const ep = f.best.expectedProfit;
      if (!prev) {
        ins.run(f.key, f.kind, f.family, f.sellHouseId, f.itemId, f.recipeId ?? null, f.rank ?? null, ep, f.best.risk.level, JSON.stringify(f), now, now, f.dataAt);
        created.push(f.key);
      } else {
        const state = prev.state === 'gone' ? 'new' : ep < prev.expected_profit * (1 - FADING_SHARE) ? 'fading' : 'live';
        if (prev.state === 'gone') created.push(f.key);
        upd.run(f.kind, f.family, f.sellHouseId, f.itemId, f.recipeId ?? null, state, f.rank ?? null, ep, f.best.risk.level, JSON.stringify(f), now, now, f.dataAt, f.key);
      }
      hist.run(f.dataAt, f.key, ep, f.perItem, f.best.units);
    }
    const seen = new Set(result.flips.map(f => f.key));
    const mark = db.prepare(`UPDATE flips SET state = 'gone', gone_at = ?, rank = NULL WHERE key = ?`);
    for (const r of db.prepare(`SELECT key FROM flips WHERE state != 'gone'`).all() as Array<{ key: string }>) {
      if (!seen.has(r.key)) { mark.run(now, r.key); gone.push(r.key); }
    }
    db.prepare(`DELETE FROM flips WHERE state = 'gone' AND gone_at < ?`).run(now - 24 * 3600_000);
  });
  return { created, gone };
}
