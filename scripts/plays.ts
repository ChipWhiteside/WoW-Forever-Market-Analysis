/**
 * Why is Now empty? Prints what the engine has stored: plays by type and state, how many are in the old card
 * format, the latest snapshot per house, and the best few plays. Usage: npm run plays
 */
import { loadConfig } from '../src/config/env.ts';
import { openDb } from '../src/store/db.ts';
import { money } from '../src/format/money.ts';

const db = openDb(loadConfig().dataDir);
const rows = db.prepare(`SELECT detector, state, user_status, profit, summary, detail FROM plays`).all() as Array<{ detector: string; state: string; user_status: string | null; profit: number; summary: string; detail: string }>;
const oldFormat = rows.filter(r => !JSON.parse(r.detail).buy).length;
console.log(`\n${rows.length} plays stored, ${oldFormat} in the old card format (hidden; rebuilt when the engine starts).`);
const by = new Map<string, number>();
for (const r of rows) { const k = `${r.detector} ${r.state}${r.user_status ? ` (${r.user_status})` : ''}`; by.set(k, (by.get(k) ?? 0) + 1); }
for (const [k, n] of [...by].sort()) console.log(`  ${k}: ${n}`);
console.log('\nLatest snapshot per house:');
for (const h of db.prepare(`SELECT h.id, h.faction, h.pinned, MAX(s.published_at) t, (SELECT rows FROM snapshots WHERE house_id = h.id ORDER BY published_at DESC LIMIT 1) n FROM houses h LEFT JOIN snapshots s ON s.house_id = h.id WHERE h.tracked = 1 GROUP BY h.id`).all() as Array<{ id: number; faction: string; pinned: number; t: number | null; n: number | null }>)
  console.log(`  ${h.id} ${h.faction}${h.pinned ? ' (yours)' : ''}: ${h.t ? new Date(h.t).toLocaleTimeString() : 'none'}, ${h.n ?? 0} rows`);
const items = db.prepare(`SELECT COUNT(*) n, SUM(sell_price > 0) withSell FROM items`).get() as { n: number; withSell: number };
const vend = db.prepare(`SELECT COUNT(*) n FROM vendor_items WHERE faction IN ('alliance','neutral')`).get() as { n: number };
console.log(`\nCatalog: ${items.n} items, ${items.withSell} with a vendor price. Alliance usable vendor items: ${vend.n}.`);
console.log('\nBest live plays:');
for (const r of rows.filter(r => r.state !== 'gone').sort((a, b) => b.profit - a.profit).slice(0, 8)) console.log(`  ${money(r.profit)}  ${r.summary}`);
console.log();
