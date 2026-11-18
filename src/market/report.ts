import type { DB } from '../store/db.ts';
import { primaryHouse } from '../analysis/prices.ts';

/**
 * The market read from the bot report spec: whole market aggregates, category share, top items by value,
 * movers once a week of history exists, and trend insight. Insight only, never alerted.
 */
export function marketReport(db: DB) {
  const house = primaryHouse(db);
  if (!house) return { house: null };
  const latest = db.prepare(`SELECT kind, MAX(published_at) t FROM snapshots WHERE house_id = ? GROUP BY kind`).all(house.id) as Array<{ kind: string; t: number }>;
  const ts = latest.map(l => l.t);
  if (!ts.length) return { house };
  const now = db.prepare(`SELECT s.item_id, s.floor, s.total_units, s.units_within5, i.name, i.quality, i.icon_url, i.item_class FROM item_stats s LEFT JOIN items i ON i.id = s.item_id
    WHERE s.house_id = ? AND s.published_at IN (${ts.map(() => '?').join(',')}) AND s.floor IS NOT NULL`).all(house.id, ...ts) as Array<{
    item_id: number; floor: number; total_units: number; units_within5: number; name: string | null; quality: string | null; icon_url: string | null; item_class: string | null }>;
  const value = (r: { floor: number; total_units: number }) => r.floor * r.total_units;
  const totals = { value: now.reduce((s, r) => s + value(r), 0), items: now.length, units: now.reduce((s, r) => s + r.total_units, 0) };
  const cats = new Map<string, number>();
  for (const r of now) cats.set(r.item_class ?? 'Unknown', (cats.get(r.item_class ?? 'Unknown') ?? 0) + value(r));
  const byValue = [...now].sort((a, b) => value(b) - value(a)).slice(0, 150);
  const first = db.prepare(`SELECT MIN(published_at) t FROM snapshots WHERE house_id = ?`).get(house.id) as { t: number };
  const days = (Math.max(...ts) - first.t) / 86_400_000;
  // Movers: compare with the floor about a week ago, or as far back as history goes, on the top 150 by value only.
  const back = Math.max(first.t, Math.max(...ts) - 7 * 86_400_000);
  const thenQ = db.prepare(`SELECT floor, total_units FROM item_stats WHERE house_id = ? AND item_id = ? AND published_at >= ? AND floor IS NOT NULL ORDER BY published_at LIMIT 1`);
  const movers = byValue.map(r => {
    const t = thenQ.get(house.id, r.item_id, back) as { floor: number; total_units: number } | undefined;
    return { ...r, value: value(r), floorThen: t?.floor ?? null, unitsThen: t?.total_units ?? null, change: t?.floor ? (r.floor - t.floor) / t.floor : null };
  }).filter(r => r.change != null);
  return {
    house, totals, historyDays: Math.round(days * 10) / 10, comparedFrom: back,
    categories: [...cats.entries()].map(([name, v]) => ({ name, value: v, share: v / Math.max(1, totals.value) })).sort((a, b) => b.value - a.value),
    topByValue: byValue.slice(0, 25).map(r => ({ ...r, value: value(r) })),
    topByUnits: [...now].sort((a, b) => b.total_units - a.total_units).slice(0, 15),
    risers: [...movers].sort((a, b) => b.change! - a.change!).slice(0, 10),
    fallers: [...movers].sort((a, b) => a.change! - b.change!).slice(0, 10),
  };
}
