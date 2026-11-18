/**
 * Live data contract check. Pulls one real response from every source we depend on, validates it against its
 * contract, and applies the ledger rules: zero and empty are suspected bugs. Exit code 1 on any failure.
 * Usage: npm run contract
 */
import { loadConfig } from '../src/config/env.ts';
import { BlizzardClient } from '../src/blizzard/client.ts';
import { HouseIndex, HouseResponse, CommoditiesResponse, ItemResponse, ProfessionIndex, Recipe, MediaResponse } from '../src/blizzard/contracts.ts';
import { EG_BASE, EG_PRODUCT } from '../src/datasets/eglink.ts';

const cfg = loadConfig();
const c = new BlizzardClient(cfg.clientId, cfg.clientSecret, cfg.region);
const results: Array<{ check: string; ok: boolean; note: string }> = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try { results.push({ check: name, ok: true, note: await fn() }); } catch (e) { results.push({ check: name, ok: false, note: (e as Error).message.slice(0, 200) }); }
};
const must = (cond: boolean, msg: string) => { if (!cond) throw new Error(`suspected bug: ${msg}`); };

await check('house index', async () => { const r = await c.get(c.url('/data/wow/ruleset/2/auctions/', 'dynamic'), HouseIndex); must((r.body?.auctions.length ?? 0) >= 10, 'fewer than 10 houses'); return `${r.body!.auctions.length} houses`; });
await check('house 110 auctions', async () => { const r = await c.get(c.url('/data/wow/ruleset/2/auctions/110', 'dynamic'), HouseResponse); const n = r.body?.auctions?.length ?? 0; must(n > 1000, `${n} rows`); must(!!r.lastModified, 'no Last-Modified'); must(r.body!.auctions!.every(a => a.quantity === 1), 'equipment quantity above 1, V13 changed'); return `${n} rows, ${r.lastModified}`; });
await check('house 110 commodities', async () => { const r = await c.get(c.url('/data/wow/ruleset/2/auctions/110/commodities', 'dynamic'), CommoditiesResponse); const n = r.body?.auctions.length ?? 0; must(n > 1000, `${n} rows`); return `${n} rows`; });
await check('item 2589 Linen Cloth', async () => { const r = await c.get(c.url('/data/wow/item/2589', 'static'), ItemResponse); must(r.body?.name === 'Linen Cloth', `name ${r.body?.name}`); must((r.body?.sell_price ?? 0) > 0, 'no sell_price'); return `sell ${r.body!.sell_price}c, binding ${r.body!.binding?.type ?? 'none'}`; });
await check('item media', async () => { const r = await c.get(c.url('/data/wow/media/item/2589', 'static'), MediaResponse); must(!!r.body?.assets?.find(a => a.key === 'icon'), 'no icon asset'); return 'icon present'; });
await check('professions', async () => { const r = await c.get(c.url('/data/wow/profession/index', 'static'), ProfessionIndex); must((r.body?.professions.length ?? 0) >= 10, 'few professions'); return `${r.body!.professions.length} professions`; });
await check('recipe 1631', async () => { const r = await c.get(c.url('/data/wow/recipe/1631', 'static'), Recipe); must(r.body?.crafted_item?.id === 2862, 'crafted item changed'); return `${r.body!.name}`; });
await check('EG Link index', async () => { const r = await fetch(`${EG_BASE}/index.json`); must(r.ok, `status ${r.status}`); const j = await r.json() as { products: Record<string, Record<string, unknown>> }; const n = Object.keys(j.products[EG_PRODUCT] ?? {}).length; must(n > 0, 'no live builds'); return `${n} builds`; });
await check('wago builds', async () => { const r = await fetch('https://wago.tools/api/builds'); const j = await r.json() as Record<string, Array<{ version: string }>>; must(!!j['wowf']?.[0], 'no wowf build'); return j['wowf']![0]!.version; });

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check.padEnd(24)} ${r.note}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
