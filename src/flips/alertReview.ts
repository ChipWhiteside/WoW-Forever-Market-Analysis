import type { DB } from '../store/db.ts';

/**
 * Review of sent flip alerts, so the Good and Amazing bars can be tuned (Chip, November 26).
 * For each alert: was the flip still on the list at the next publishes (flip_history), and did the product sell near
 * the claimed price over the night after (item_stats sold_units in snapshots whose floor stayed within 10 percent of
 * the claim or above). There is no backtest module yet (flip plan section 9 describes one); this reads the same history.
 */
export interface AlertReview {
  key: string; at: number; tier: string; expectedProfit: number; perItem: number; units: number;
  /** of the next `runs` complete flip runs after the alert, how many still listed the flip */
  liveNext: number; runsAfter: number;
  /** units judged sold on the sell house within the horizon at a floor near the claim; null for vendor sales or no claim */
  soldNearClaim: number | null;
  /** all units judged sold on the sell house within the horizon, and the floor range seen */
  soldAll: number | null; floorMin: number | null; floorMax: number | null; snapshots: number;
  verdict: string;
}

export function reviewAlerts(db: DB, opts: { since?: number; now?: number; runs?: number; horizonHours?: number; near?: number } = {}): AlertReview[] {
  const now = opts.now ?? Date.now();
  const since = opts.since ?? now - 7 * 24 * 3600_000;
  const runs = opts.runs ?? 3, horizon = (opts.horizonHours ?? 10) * 3600_000, near = opts.near ?? 0.9;
  const alerts = db.prepare('SELECT key, at, tier, expected_profit, per_item, units, item_id, house_id, claim_price FROM flip_alerts WHERE at >= ? ORDER BY at DESC')
    .all(since) as Array<{ key: string; at: number; tier: string; expected_profit: number; per_item: number; units: number; item_id: number | null; house_id: number | null; claim_price: number | null }>;
  const nextRuns = db.prepare('SELECT at FROM flip_runs WHERE at > ? AND complete = 1 ORDER BY at LIMIT ?');
  const inHist = db.prepare('SELECT 1 FROM flip_history WHERE at = ? AND key = ?');
  const stats = db.prepare('SELECT floor, sold_units FROM item_stats WHERE house_id = ? AND item_id = ? AND published_at > ? AND published_at <= ? ORDER BY published_at');
  return alerts.map(a => {
    const after = (nextRuns.all(a.at, runs) as Array<{ at: number }>).map(r => r.at);
    const liveNext = after.filter(t => inHist.get(t, a.key)).length;
    let soldNearClaim: number | null = null, soldAll: number | null = null, floorMin: number | null = null, floorMax: number | null = null, snapshots = 0;
    if (a.house_id != null && a.item_id != null) {
      const rows = stats.all(a.house_id, a.item_id, a.at, Math.min(now, a.at + horizon)) as Array<{ floor: number | null; sold_units: number | null }>;
      snapshots = rows.length;
      soldAll = rows.reduce((s, r) => s + (r.sold_units ?? 0), 0);
      const floors = rows.map(r => r.floor).filter((f): f is number => f != null);
      floorMin = floors.length ? Math.min(...floors) : null; floorMax = floors.length ? Math.max(...floors) : null;
      if (a.claim_price != null) soldNearClaim = rows.filter(r => r.floor != null && r.floor >= a.claim_price! * near).reduce((s, r) => s + (r.sold_units ?? 0), 0);
    }
    const parts: string[] = [];
    parts.push(after.length ? `live at ${liveNext} of the next ${after.length} runs` : 'no run since');
    if (a.house_id == null) parts.push('sells to a vendor');
    else if (!snapshots) parts.push('no publish since');
    else if (soldNearClaim != null) parts.push(soldNearClaim >= a.units ? `sold ${soldNearClaim} near the claim, covers the ${a.units}` : `sold ${soldNearClaim} near the claim, short of the ${a.units}`);
    return { key: a.key, at: a.at, tier: a.tier, expectedProfit: a.expected_profit, perItem: a.per_item, units: a.units, liveNext, runsAfter: after.length,
      soldNearClaim, soldAll, floorMin, floorMax, snapshots, verdict: parts.join('; ') };
  });
}
