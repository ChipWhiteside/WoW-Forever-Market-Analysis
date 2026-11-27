import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../store/db.ts';

export interface HouseHealth { id: number; name: string; lastPublish: number | null; ageMin: number | null; status: 'ok' | 'late' | 'missing'; lastError: string | null }
export interface Health { at: number; status: 'ok' | 'warn' | 'error'; houses: HouseHealth[]; suspects: string[]; gapsToday: number; message: string }

/**
 * A house is late when its last publish is older than 75 minutes. Blizzard publishes about hourly (V17).
 * Every tracked house, or only the houses in `only` (the cloud polls Chip's two houses, not every tracked one).
 */
export function computeHealth(db: DB, now = Date.now(), suspects: string[] = [], only?: number[]): Health {
  const houses = (db.prepare(`SELECT h.id, h.name, MAX(s.published_at) t FROM houses h LEFT JOIN snapshots s ON s.house_id = h.id WHERE h.tracked = 1 GROUP BY h.id ORDER BY h.id`).all() as Array<{ id: number; name: string; t: number | null }>)
    .filter(h => !only || only.includes(h.id));
  const err = db.prepare(`SELECT note FROM poll_log WHERE house_id = ? AND status < 0 AND at > ? ORDER BY at DESC LIMIT 1`);
  const hh: HouseHealth[] = houses.map(h => {
    const ageMin = h.t == null ? null : Math.round((now - h.t) / 60_000);
    const e = err.get(h.id, now - 30 * 60_000) as { note: string } | undefined;
    return { id: h.id, name: h.name, lastPublish: h.t, ageMin, status: h.t == null ? 'missing' : ageMin! > 75 ? 'late' : 'ok', lastError: e?.note ?? null };
  });
  const gapsToday = countGaps(db, now - 24 * 3600_000, now);
  const bad = hh.filter(h => h.status !== 'ok');
  const status = suspects.length || hh.some(h => h.lastError) ? 'error' : bad.length || gapsToday ? 'warn' : 'ok';
  const message = status === 'ok' ? 'Every house published on time.' :
    [bad.length ? `${bad.map(h => `${h.name} ${h.id} ${h.status === 'missing' ? 'has no data yet' : `is ${h.ageMin} min old`}`).join(', ')}.` : '',
     gapsToday ? `${gapsToday} missed hour${gapsToday === 1 ? '' : 's'} in the last day, gone from history.` : '',
     suspects.length ? `Suspected bugs: ${suspects.join('; ')}.` : ''].filter(Boolean).join(' ');
  return { at: now, status, houses: hh, suspects, gapsToday, message };
}

/** Hours with no publish between two consecutive publishes of the same house and kind. */
export function countGaps(db: DB, from: number, to: number): number {
  const rows = db.prepare(`SELECT house_id, kind, published_at FROM snapshots WHERE published_at BETWEEN ? AND ? ORDER BY house_id, kind, published_at`).all(from, to) as Array<{ house_id: number; kind: string; published_at: number }>;
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!, b = rows[i]!;
    if (a.house_id !== b.house_id || a.kind !== b.kind) continue;
    const hours = (b.published_at - a.published_at) / 3600_000;
    if (hours > 1.6) gaps += Math.round(hours) - 1;
  }
  return gaps;
}

/** Run reports are what the overnight auditor reads. One JSON line per cycle, a file per day. */
export function writeRunReport(dataDir: string, report: Record<string, unknown>): void {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `runs-${day}.jsonl`), JSON.stringify(report) + '\n', { flag: 'a' });
}
