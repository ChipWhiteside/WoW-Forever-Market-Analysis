import type { DB } from '../store/db.ts';

/**
 * Calibration: how each detector actually behaves on Chip's houses. Plays found, how long they live before
 * closing (the "plays like this usually last" number), and how often he acted. Gets better every week.
 * The overnight loop reads this to propose threshold changes; only Chip approves them.
 */
export interface DetectorStats { detector: string; plays: number; medianLifeMin: number | null; p25LifeMin: number | null; done: number; skipped: number; alreadyGone: number; medianPeakProfit: number | null }

export function calibration(db: DB, days = 14, now = Date.now()): DetectorStats[] {
  const since = now - days * 86_400_000;
  const rows = db.prepare(`SELECT detector, first_seen, gone_at, peak_profit, user_status FROM play_history WHERE first_seen >= ?
    UNION ALL SELECT detector, first_seen, gone_at, peak_profit, user_status FROM plays WHERE first_seen >= ? AND state = 'gone'`).all(since, since) as Array<{
    detector: string; first_seen: number; gone_at: number | null; peak_profit: number; user_status: string | null }>;
  const by = new Map<string, typeof rows>();
  for (const r of rows) { const a = by.get(r.detector) ?? []; a.push(r); by.set(r.detector, a); }
  const q = (xs: number[], p: number) => xs.length ? xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]! : null;
  return [...by.entries()].map(([detector, rs]) => {
    const lives = rs.filter(r => r.gone_at).map(r => (r.gone_at! - r.first_seen) / 60_000);
    return {
      detector, plays: rs.length,
      medianLifeMin: q(lives, 0.5) == null ? null : Math.round(q(lives, 0.5)!), p25LifeMin: q(lives, 0.25) == null ? null : Math.round(q(lives, 0.25)!),
      done: rs.filter(r => r.user_status === 'done').length, skipped: rs.filter(r => r.user_status === 'skipped').length,
      alreadyGone: rs.filter(r => r.user_status === 'already_gone').length, medianPeakProfit: q(rs.map(r => r.peak_profit), 0.5),
    };
  });
}
