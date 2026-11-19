/**
 * When does each house actually publish? Reads the engine's own record of every snapshot (Blizzard's Last-Modified)
 * and prints the recent publish times per house, the gaps between them, and the usual minute past the hour.
 * Usage: npm run publish-times
 */
import { loadConfig } from '../src/config/env.ts';
import { openDb } from '../src/store/db.ts';

const db = openDb(loadConfig().dataDir);
const rows = db.prepare(`SELECT house_id, kind, published_at, fetched_at FROM snapshots WHERE published_at > ? ORDER BY house_id, kind, published_at`)
  .all(Date.now() - 24 * 3600_000) as Array<{ house_id: number; kind: string; published_at: number; fetched_at: number }>;
if (!rows.length) { console.log('No snapshots in the last 24 hours. Is the engine running? Check the Health page.'); process.exit(0); }
const t = (ms: number) => new Date(ms).toLocaleTimeString();
const groups = new Map<string, typeof rows>();
for (const r of rows) { const k = `${r.house_id} ${r.kind}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
for (const [k, rs] of groups) {
  const gaps = rs.slice(1).map((r, i) => Math.round((r.published_at - rs[i]!.published_at) / 60_000));
  const minutes = rs.map(r => new Date(r.published_at).getMinutes());
  const lag = rs.map(r => Math.round((r.fetched_at - r.published_at) / 60_000));
  console.log(`\nHouse ${k}: ${rs.length} publishes in 24h`);
  console.log(`  last 6 publish times: ${rs.slice(-6).map(r => t(r.published_at)).join(', ')}`);
  console.log(`  minutes between publishes: ${gaps.slice(-8).join(', ') || 'only one so far'}`);
  console.log(`  minute past the hour: ${minutes.slice(-8).join(', ')}`);
  console.log(`  minutes from publish to the engine having it: ${lag.slice(-8).join(', ')}`);
}
const latest = db.prepare(`SELECT house_id, MAX(published_at) t FROM snapshots GROUP BY house_id`).all() as Array<{ house_id: number; t: number }>;
console.log(`\nRight now (${t(Date.now())}), the data for each house was published:`);
for (const l of latest) console.log(`  house ${l.house_id}: ${t(l.t)}, ${Math.round((Date.now() - l.t) / 60_000)} min ago`);
