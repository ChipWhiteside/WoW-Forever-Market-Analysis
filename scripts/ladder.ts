/**
 * Every listing of one item on one house, straight from Blizzard, grouped by price exactly like the in game
 * auction house shows it: price, units at that price, and how many separate listings make it up.
 *
 * Usage:  npm run ladder -- <house> <item name or id>
 *   npm run ladder -- 111 "Copper Ore"
 *   npm run ladder -- 111 2589
 * Also writes a CSV next to your data so you can compare it side by side with a screenshot.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/env.ts';
import { openDb } from '../src/store/db.ts';
import { BlizzardClient } from '../src/blizzard/client.ts';
import { CommoditiesResponse, HouseResponse, ItemResponse } from '../src/blizzard/contracts.ts';
import { money } from '../src/format/money.ts';

const [houseArg, ...itemParts] = process.argv.slice(2);
const itemArg = itemParts.join(' ').trim();
if (!houseArg || !itemArg) { console.log('usage: npm run ladder -- <house> <item name or id>   e.g.  npm run ladder -- 111 "Copper Ore"'); process.exit(2); }
const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const c = new BlizzardClient(cfg.clientId, cfg.clientSecret, cfg.region);

// Resolve the item: an id, or a name from the engine's catalog (exact name first, then a unique partial match).
let itemId = /^\d+$/.test(itemArg) ? Number(itemArg) : null;
if (itemId == null) {
  const exact = db.prepare('SELECT id, name FROM items WHERE lower(name) = lower(?)').all(itemArg) as Array<{ id: number; name: string }>;
  const partial = exact.length ? exact : db.prepare('SELECT id, name FROM items WHERE name LIKE ? LIMIT 10').all(`%${itemArg}%`) as Array<{ id: number; name: string }>;
  if (partial.length !== 1) {
    console.log(partial.length ? `"${itemArg}" matches several items, use the id:\n${partial.map(p => `  ${p.id}  ${p.name}`).join('\n')}` : `No item named "${itemArg}" in the catalog yet. Use the item id instead.`);
    process.exit(1);
  }
  itemId = partial[0]!.id;
}
const item = await c.get(c.url(`/data/wow/item/${itemId}`, 'static'), ItemResponse);
const name = item.body?.name ?? `Item ${itemId}`;

// Stackables live under commodities, everything else under the house itself. Read both.
const base = `/data/wow/ruleset/2/auctions/${houseArg}`;
const [com, eq] = await Promise.all([c.get(c.url(`${base}/commodities`, 'dynamic'), CommoditiesResponse), c.get(c.url(base, 'dynamic'), HouseResponse)]);
const rows: Array<{ unit: number; qty: number }> = [];
for (const r of com.body?.auctions ?? []) if (r.item.id === itemId) rows.push({ unit: r.unit_price, qty: r.quantity });
let bidOnly = 0;
for (const r of eq.body?.auctions ?? []) if (r.item.id === itemId) {
  if (r.buyout == null || r.buyout <= 0) { bidOnly++; continue; }
  rows.push({ unit: Math.floor(r.buyout / r.quantity), qty: r.quantity });
}
if (!rows.length) {
  console.log(`No buyout listings of ${name} (${itemId}) on house ${houseArg}. Suspected bug until checked in game: is the house id and item right?`);
  process.exit(1);
}

const ladder = new Map<number, { units: number; listings: number }>();
for (const r of rows) { const l = ladder.get(r.unit) ?? { units: 0, listings: 0 }; l.units += r.qty; l.listings++; ladder.set(r.unit, l); }
const steps = [...ladder.entries()].sort((a, b) => a[0] - b[0]);
const total = rows.reduce((s, r) => s + r.qty, 0);
const snap = com.lastModified ?? eq.lastModified;

console.log(`\n${name} (${itemId}) on house ${houseArg}`);
console.log(`Snapshot published ${snap ? new Date(snap).toLocaleString() : 'unknown'}, ${snap ? Math.round((Date.now() - Date.parse(snap)) / 60_000) : '?'} min ago`);
console.log(`${total.toLocaleString()} available in ${rows.length.toLocaleString()} listings at ${steps.length} prices${bidOnly ? `, plus ${bidOnly} bid only` : ''}\n`);
console.log('   #   price         available   listings');
steps.forEach(([p, l], i) => console.log(`${String(i + 1).padStart(4)}   ${money(p).padEnd(12)} ${l.units.toLocaleString().padStart(10)}   ${String(l.listings).padStart(8)}`));

const dir = join(cfg.dataDir, 'ladders');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${houseArg}-${itemId}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`);
writeFileSync(file, 'rank,price_copper,available,listings\n' + steps.map(([p, l], i) => `${i + 1},${p},${l.units},${l.listings}`).join('\n') + '\n');
console.log(`\nSaved: ${file}\n`);
