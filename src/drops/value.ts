import type { DB } from '../store/db.ts';
import type { PriceBook } from '../analysis/prices.ts';
import { netPerUnit } from '../rules/fees.ts';

/**
 * O8 World drops. Farming happens by source, not by item, so the main view ranks sources by value per kill:
 * every sellable drop times its expected units per kill times its net value. Net value is the better of the
 * vendor price and the auction floor after cut, and only the vendor price for bind on pickup items.
 * Rates come from player recorded Forever kills and always show how many kills they rest on.
 */
export const KILLS_PER_HOUR: Record<string, number> = { normal: 60, elite: 20, rare: 0, fishing: 100, container: 0, node: 30 };
export const ROUGH_BELOW = 50;

export function itemValue(book: PriceBook, itemId: number): { value: number; how: 'auction' | 'vendor' | 'none' } {
  const sell = book.sell.get(itemId) ?? 0;
  if (book.binding.get(itemId) === 'ON_ACQUIRE') return { value: sell, how: sell ? 'vendor' : 'none' };
  const f = book.floor.get(itemId);
  const ah = f ? netPerUnit(book.faction, f.floor, sell) : 0;
  return ah > sell ? { value: ah, how: 'auction' } : { value: sell, how: sell ? 'vendor' : 'none' };
}

export interface SourceRow {
  kind: string; sourceId: number; name: string; zone: string | null; minLevel: number | null; maxLevel: number | null; classification: string | null;
  kills: number; valuePerKill: number; goldPerHour: number | null; perHourBasis: string; rough: boolean;
  top: Array<{ itemId: number; name: string; perKill: number; value: number; how: string }>;
}

/** Sources with fewer recorded kills than this are hidden by default: one lucky kill is not a rate. */
export const MIN_KILLS_DEFAULT = 10;

export function sourceBoard(db: DB, book: PriceBook, opts: { minLevel?: number; maxLevel?: number; kind?: string; measured?: Map<string, number>; minKills?: number } = {}): SourceRow[] {
  const rows = db.prepare(`SELECT source_kind, source_id, source_name, zone, min_level, max_level, classification, item_id, avg_count, kills FROM loot WHERE origin = 'forever'`).all() as Array<{
    source_kind: string; source_id: number; source_name: string | null; zone: string | null; min_level: number | null; max_level: number | null; classification: string | null; item_id: number; avg_count: number; kills: number }>;
  const by = new Map<string, SourceRow>();
  for (const r of rows) {
    const key = `${r.source_kind}:${r.source_id}`;
    let s = by.get(key);
    if (!s) {
      const name = r.source_name ?? (r.source_kind === 'item' ? `${book.names.get(r.source_id) ?? `Container ${r.source_id}`}` : `${r.source_kind} ${r.source_id}`);
      s = { kind: r.source_kind, sourceId: r.source_id, name, zone: r.zone, minLevel: r.min_level, maxLevel: r.max_level, classification: r.classification,
        kills: r.kills, valuePerKill: 0, goldPerHour: null, perHourBasis: '', rough: r.kills < ROUGH_BELOW, top: [] };
      by.set(key, s);
    }
    const v = itemValue(book, r.item_id);
    const each = v.value * r.avg_count;
    s.valuePerKill += each;
    s.top.push({ itemId: r.item_id, name: book.names.get(r.item_id) ?? `Item ${r.item_id}`, perKill: r.avg_count, value: Math.round(each), how: v.how });
  }
  const out: SourceRow[] = [];
  for (const s of by.values()) {
    if (opts.kind && !s.kind.startsWith(opts.kind)) continue;
    if (s.kills < (opts.minKills ?? MIN_KILLS_DEFAULT)) continue;
    if (opts.minLevel != null && (s.maxLevel ?? 0) && (s.maxLevel ?? 0) < opts.minLevel) continue;
    if (opts.maxLevel != null && (s.minLevel ?? 0) > opts.maxLevel) continue;
    s.top = s.top.filter(t => t.value > 0).sort((a, b) => b.value - a.value).slice(0, 6);
    s.valuePerKill = Math.round(s.valuePerKill);
    const cls = s.kind === 'fishing' ? 'fishing' : s.kind === 'item' ? 'container' : s.kind.startsWith('object') ? 'node' : /rare/.test(s.classification ?? '') ? 'rare' : /elite/.test(s.classification ?? '') ? 'elite' : 'normal';
    const measured = opts.measured?.get(`${s.kind}:${s.sourceId}`);
    const kph = measured ?? KILLS_PER_HOUR[cls] ?? 0;
    s.goldPerHour = kph ? Math.round(s.valuePerKill * kph) : null;
    s.perHourBasis = measured ? `measured, ${measured} an hour` : kph ? `estimated, ${kph} ${cls === 'fishing' ? 'catches' : cls === 'node' ? 'nodes' : 'kills'} an hour` : cls === 'container' ? 'value per open' : 'value per kill, rare spawn';
    out.push(s);
  }
  return out.sort((a, b) => (b.goldPerHour ?? b.valuePerKill) - (a.goldPerHour ?? a.valuePerKill));
}
