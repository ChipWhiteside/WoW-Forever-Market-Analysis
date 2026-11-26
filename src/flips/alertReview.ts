import type { DB } from '../store/db.ts';

/**
 * Review of sent flip alerts, so the Good and Amazing bars can be tuned (Chip, November 26).
 * For each alert: was the flip still on the list at the next distinct publishes (flip_runs data_at after the alert's
 * data_at, so a refresh rerun on the same data never counts; refresh round 1 finding C), and did the product sell near
 * the claimed price over the night after (item_stats sold_units in snapshots whose floor stayed within 10 percent of
 * the claim or above). There is no backtest module yet (flip plan section 9 describes one); this reads the same history.
 */
export interface AlertReview {
  key: string; name: string; at: number; tier: string; expectedProfit: number; perItem: number; units: number;
  /** of the next `runs` distinct publishes after the alert's data (complete runs), how many still listed the flip */
  liveNext: number; publishesAfter: number;
  /** fewer than `runs` publishes since the alert: too soon to say whether it stayed live */
  tooSoon: boolean;
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
  // Only alerts that reached Discord: a failed or still pending claim was never seen by Chip.
  const alerts = db.prepare(`SELECT a.key, a.at, a.tier, a.expected_profit, a.per_item, a.units, a.data_at, a.item_id, a.house_id, a.claim_price, i.name
      FROM flip_alerts a LEFT JOIN items i ON i.id = a.item_id WHERE a.at >= ? AND a.status = 'sent' ORDER BY a.at DESC`)
    .all(since) as Array<{ key: string; at: number; tier: string; expected_profit: number; per_item: number; units: number; data_at: number; item_id: number | null; house_id: number | null; claim_price: number | null; name: string | null }>;
  // Distinct publishes, not runs: every rerun on one publish shares its data_at.
  const nextData = db.prepare('SELECT DISTINCT data_at FROM flip_runs WHERE data_at > ? AND complete = 1 ORDER BY data_at LIMIT ?');
  // flip_history is keyed by data hour; a flip is live at a publish when it has a row from that publish up to the next.
  const inHist = db.prepare('SELECT 1 FROM flip_history WHERE key = ? AND at >= ? AND at < ? LIMIT 1');
  const stats = db.prepare('SELECT floor, sold_units FROM item_stats WHERE house_id = ? AND item_id = ? AND published_at > ? AND published_at <= ? ORDER BY published_at');
  return alerts.map(a => {
    const next = (nextData.all(a.data_at, runs + 1) as Array<{ data_at: number }>).map(r => r.data_at);
    const after = next.slice(0, runs);
    const liveNext = after.filter((t, i) => inHist.get(a.key, t, next[i + 1] ?? Number.MAX_SAFE_INTEGER)).length;
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
    const pub = (n: number) => `${n} publish${n === 1 ? '' : 'es'}`;
    const tooSoon = after.length < runs;
    parts.push(!after.length ? 'no new publish since, too soon to judge'
      : tooSoon ? `live at ${liveNext} of ${pub(after.length)} so far; only ${pub(after.length)} since, too few to judge yet (needs ${runs})`
      : `live at ${liveNext} of the next ${pub(after.length)}`);
    if (a.house_id == null) parts.push('sells to a vendor');
    else if (!snapshots) parts.push('no publish since');
    else if (soldNearClaim != null) parts.push(soldNearClaim >= a.units ? `sold ${soldNearClaim} near the claim, covers the ${a.units}` : `sold ${soldNearClaim} near the claim, short of the ${a.units}`);
    return { key: a.key, name: a.name ?? a.key, at: a.at, tier: a.tier, expectedProfit: a.expected_profit, perItem: a.per_item, units: a.units, liveNext, publishesAfter: after.length, tooSoon,
      soldNearClaim, soldAll, floorMin, floorMax, snapshots, verdict: parts.join('; ') };
  });
}
