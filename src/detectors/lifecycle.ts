import type { DB } from '../store/db.ts';
import { tx } from '../store/db.ts';
import { FADING_SHARE } from '../rules/thresholds.ts';
import type { Play, DetectorId } from './types.ts';

export interface LifecycleResult { created: Play[]; updated: Play[]; gone: string[] }

/**
 * Persist this cycle's plays. New keys start as `new`, repeats become `live`, a repeat whose profit
 * shrank by a quarter is `fading`, and a key from an evaluated detector and house that did not come back is `gone`.
 * Gone plays stay visible for 24 hours (spec 6.4).
 */
export function applyLifecycle(db: DB, plays: Play[], evaluated: { detectors: DetectorId[]; houses: number[] }, now = Date.now()): LifecycleResult {
  const created: Play[] = [], updated: Play[] = [], gone: string[] = [];
  const seen = new Set(plays.map(p => p.key));
  tx(db, () => {
    const get = db.prepare('SELECT profit, peak_profit, state, snapshots_seen, data_at FROM plays WHERE key = ?');
    const ins = db.prepare(`INSERT INTO plays (key, detector, house_id, item_id, state, profit, peak_profit, confidence, summary, detail, first_seen, last_seen, data_at, snapshots_seen)
      VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const upd = db.prepare(`UPDATE plays SET state = ?, profit = ?, peak_profit = MAX(peak_profit, ?), confidence = ?, summary = ?, detail = ?, last_seen = ?,
      data_at = ?, snapshots_seen = snapshots_seen + ?, gone_at = NULL WHERE key = ?`);
    for (const p of plays) {
      const prev = get.get(p.key) as { profit: number; state: string; data_at: number } | undefined;
      if (!prev) {
        ins.run(p.key, p.detector, p.houseId, p.itemId, p.profit, p.profit, p.confidence, p.summary, JSON.stringify(p.detail), now, now, p.dataAt);
        created.push(p);
        continue;
      }
      const reborn = prev.state === 'gone';
      const newData = p.dataAt !== prev.data_at;
      const state = reborn ? 'new' : p.profit < prev.profit * (1 - FADING_SHARE) ? 'fading' : prev.state === 'new' && !newData ? 'new' : 'live';
      upd.run(state, p.profit, p.profit, p.confidence, p.summary, JSON.stringify(p.detail), now, p.dataAt, newData ? 1 : 0, p.key);
      (reborn ? created : updated).push(p);
    }
    if (evaluated.detectors.length && evaluated.houses.length) {
      const q = db.prepare(`SELECT key FROM plays WHERE state != 'gone' AND detector IN (${evaluated.detectors.map(() => '?').join(',')})
        AND house_id IN (${evaluated.houses.map(() => '?').join(',')})`).all(...evaluated.detectors, ...evaluated.houses) as Array<{ key: string }>;
      const mark = db.prepare(`UPDATE plays SET state = 'gone', gone_at = ? WHERE key = ?`);
      for (const r of q) if (!seen.has(r.key)) { mark.run(now, r.key); gone.push(r.key); }
    }
    // Keep a permanent record of every finished play for the calibration report, then clear it from view.
    const old = now - 24 * 3600_000;
    db.prepare(`INSERT INTO play_history (key, detector, house_id, item_id, first_seen, gone_at, peak_profit, snapshots_seen, user_status)
      SELECT key, detector, house_id, item_id, first_seen, gone_at, peak_profit, snapshots_seen, user_status FROM plays WHERE state = 'gone' AND gone_at < ?`).run(old);
    db.prepare(`DELETE FROM plays WHERE state = 'gone' AND gone_at < ?`).run(old);
  });
  return { created, updated, gone };
}
