/**
 * Compare the screenshot ladders in scripts/seen.ts against every Alliance and Blackwater house, level by level.
 * Skips the first SKIP levels of each screenshot, which trade fastest. For each house: how many of the remaining
 * price levels exist there with the exact same units, within 10 percent, different, or not at all.
 * Usage: npm run compare-houses            (skip 6)
 *        npm run compare-houses -- 0       (compare every level)
 */
import { loadConfig } from '../src/config/env.ts';
import { BlizzardClient } from '../src/blizzard/client.ts';
import { HouseIndex, CommoditiesResponse } from '../src/blizzard/contracts.ts';
import { factionOf } from '../src/engine/houses.ts';
import { SEEN } from './seen.ts';

const SKIP = Number(process.argv[2] ?? 6);
const cfg = loadConfig();
const c = new BlizzardClient(cfg.clientId, cfg.clientSecret, cfg.region);
const index = await c.get(c.url('/data/wow/ruleset/2/auctions/', 'dynamic'), HouseIndex);
const houses = (index.body?.auctions ?? []).filter(h => factionOf(h.name) !== 'horde').sort((a, b) => a.id - b.id);
const name = (id: number) => SEEN.items.find(i => i.id === id)?.name ?? String(id);

console.log(`\nScreenshot levels ${SKIP + 1} onward, matched by exact price\n`);
console.log('house  faction      item           exact  within10%  different  missing');
const totals: Array<{ id: number; faction: string; exact: number; close: number; off: number; missing: number; at: string }> = [];
for (const h of houses) {
  let listings: Array<{ item: { id: number }; unit_price: number; quantity: number }> = [];
  let at = '';
  try {
    const r = await c.get(c.url(`/data/wow/ruleset/2/auctions/${h.id}/commodities`, 'dynamic'), CommoditiesResponse);
    listings = r.body?.auctions ?? [];
    at = r.lastModified ? new Date(r.lastModified).toLocaleTimeString() : '';
  } catch (e) { console.log(`${String(h.id).padEnd(6)} could not read: ${(e as Error).message.slice(0, 100)}`); continue; }
  if (!listings.length) { console.log(`${String(h.id).padEnd(6)} ${factionOf(h.name).padEnd(12)} no listings (dead house)`); continue; }
  const t = { id: h.id, faction: factionOf(h.name), exact: 0, close: 0, off: 0, missing: 0, at };
  for (const [itemId, seen] of Object.entries(SEEN.ladders)) {
    const ladder = new Map<number, number>();
    for (const l of listings) if (l.item.id === Number(itemId)) ladder.set(l.unit_price, (ladder.get(l.unit_price) ?? 0) + l.quantity);
    const row = { exact: 0, close: 0, off: 0, missing: 0 };
    for (const [p, u] of [...seen].sort((a, b) => a[0] - b[0]).slice(SKIP)) {
      const here = ladder.get(p);
      const k = here == null ? 'missing' : here === u ? 'exact' : Math.abs(here - u) <= Math.max(2, u * 0.1) ? 'close' : 'off';
      row[k]++; t[k]++;
    }
    console.log(`${String(h.id).padEnd(6)} ${t.faction.padEnd(12)} ${name(Number(itemId)).padEnd(14)} ${String(row.exact).padStart(5)}  ${String(row.close).padStart(9)}  ${String(row.off).padStart(9)}  ${String(row.missing).padStart(7)}`);
  }
  totals.push(t);
}
console.log('\nTotals, best first');
for (const t of totals.sort((a, b) => b.exact - a.exact || b.close - a.close)) {
  const n = t.exact + t.close + t.off + t.missing;
  console.log(`  house ${t.id} (${t.faction}): ${t.exact} exact, ${t.close} within 10%, ${t.off} different, ${t.missing} missing, of ${n}. Snapshot ${t.at}`);
}
console.log();
