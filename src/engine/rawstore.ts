import { gzipSync, gunzipSync } from 'node:zlib';
import { writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Listing } from '../analysis/aggregate.ts';

/**
 * Raw snapshots, compacted to [id, itemId, quantity, unitPrice|-1, timeLeftIndex] and gzipped.
 * Kept so detectors can be replayed after a bug fix and so differencing survives a restart.
 */
const TL = ['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG'] as const;

export function rawPath(dataDir: string, houseId: number, kind: string, publishedAt: number): string {
  const day = new Date(publishedAt).toISOString().slice(0, 10);
  return join(dataDir, 'raw', day, `${houseId}-${kind}-${publishedAt}.json.gz`);
}

export function writeRaw(path: string, listings: Listing[]): number {
  mkdirSync(join(path, '..'), { recursive: true });
  const compact = listings.map(l => [l.id, l.itemId, l.quantity, l.unitPrice ?? -1, TL.indexOf(l.timeLeft)]);
  const buf = gzipSync(JSON.stringify(compact), { level: 6 });
  writeFileSync(path, buf);
  return buf.length;
}

export function readRaw(path: string): Listing[] {
  const rows = JSON.parse(gunzipSync(readFileSync(path)).toString()) as number[][];
  return rows.map(([id, itemId, quantity, unit, tl]) => ({
    id: id!, itemId: itemId!, quantity: quantity!, unitPrice: unit === -1 ? null : unit!, timeLeft: TL[tl!] ?? 'LONG',
  }));
}

/** Delete raw days older than the retention window. Pinned houses keep longer. */
export function pruneRaw(dataDir: string, keepDays: number, keepDaysPinned: number, pinned: Set<number>): number {
  const root = join(dataDir, 'raw');
  if (!existsSync(root)) return 0;
  let removed = 0;
  const now = Date.now();
  for (const day of readdirSync(root)) {
    const dir = join(root, day);
    if (!statSync(dir).isDirectory()) continue;
    const age = (now - Date.parse(day)) / 86_400_000;
    for (const f of readdirSync(dir)) {
      const houseId = Number(f.split('-')[0]);
      const keep = pinned.has(houseId) ? keepDaysPinned : keepDays;
      if (age > keep) { rmSync(join(dir, f)); removed++; }
    }
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
  return removed;
}
