/**
 * Cuts the golden fixture for tests/e2e/goldens.test.ts from a real data directory (raw snapshots and catalog).
 *   SRC=<data dir with wowf.db and raw/> npx tsx tests/e2e/fixtures/cut-goldens.ts
 * Writes tests/e2e/fixtures/goldens.json.gz: two real consecutive publishes of houses 111 and 116 (both kinds),
 * restricted to about 150 real background items (listings) and the yardstick items (yard, their real listings, which the
 * test uses for today's prices), and the catalog rows those items need.
 * Background items are picked so that real recipes have every item they use in the fixture.
 */
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawPath, readRaw } from '../../../src/engine/rawstore.ts';
import type { Listing } from '../../../src/analysis/aggregate.ts';

const src = process.env.SRC!;
const db = new DatabaseSync(join(src, 'wowf.db'), { readOnly: true });
/** The two real publishes an hour apart (A then B) per house, from the 26 November raw files. */
const PUBS: Record<number, [number, number]> = { 111: [1795681578000, 1795685176000], 116: [1795681566000, 1795685166000] };
const YARD = [249399, 3371, 249409, 6532, 12640, 7080, 7082, 6947, 2928, 4378, 2592, 4377];
const YARD_RECIPES = [54453, 9948, 4807, 2442];
const BACKGROUND = 150;
const MAX_LISTINGS = 60;

const raw: Record<string, Listing[]> = {};
for (const [h, ts] of Object.entries(PUBS)) for (const k of ['auctions', 'commodities']) for (const t of ts) {
  // Publish stamps of the two kinds differ by a few seconds; the file holds whichever stamp is on record.
  const rows = db.prepare('SELECT published_at FROM snapshots WHERE house_id = ? AND kind = ? AND ABS(published_at - ?) < 60000').get(Number(h), k, t) as { published_at: number };
  raw[`${h}:${k}:${t}`] = readRaw(rawPath(src, Number(h), k, rows.published_at)).map(l => ({ ...l, publishedAt: rows.published_at } as Listing));
}
// Per item: listing count on house 111 in publish A, by kind.
const count = new Map<number, number>();
for (const k of ['auctions', 'commodities']) for (const l of raw[`111:${k}:${PUBS[111]![0]}`]!) count.set(l.itemId, (count.get(l.itemId) ?? 0) + 1);
const inB = new Set<number>();
for (const k of ['auctions', 'commodities']) for (const l of raw[`111:${k}:${PUBS[111]![1]}`]!) inB.add(l.itemId);
const ok = (id: number) => (count.get(id) ?? 0) >= 2 && (count.get(id) ?? 0) <= MAX_LISTINGS && inB.has(id);

const chosen = new Set<number>();
// Real recipes whose product and reagents are all listed on 111 with a modest ladder, lowest id first.
const reagents = new Map<number, number[]>();
for (const r of db.prepare('SELECT recipe_id, item_id FROM recipe_reagents').all() as Array<{ recipe_id: number; item_id: number }>) {
  const a = reagents.get(r.recipe_id) ?? []; a.push(r.item_id); reagents.set(r.recipe_id, a);
}
const bgRecipes: number[] = [];
for (const r of db.prepare('SELECT id, crafted_item_id FROM recipes WHERE crafted_item_id IS NOT NULL AND live = 1 AND random_yield = 0 ORDER BY id').all() as Array<{ id: number; crafted_item_id: number }>) {
  const ids = [r.crafted_item_id, ...(reagents.get(r.id) ?? [])];
  if (!reagents.get(r.id)?.length || !ids.every(ok)) continue;
  const fresh = ids.filter(i => !chosen.has(i));
  if (chosen.size + fresh.length > 90) continue;
  for (const i of fresh) chosen.add(i);
  bgRecipes.push(r.id);
}
// Fill to BACKGROUND with other listed items, spread over the id range.
const rest = [...count.keys()].filter(i => ok(i) && !chosen.has(i) && !YARD.includes(i)).sort((a, b) => a - b);
for (let i = 0; chosen.size < BACKGROUND && i < rest.length; i += Math.max(1, Math.floor(rest.length / (BACKGROUND - 90)))) chosen.add(rest[i]!);
for (const y of YARD) chosen.delete(y);
const items = new Set([...chosen, ...YARD]);

const pick = (ls: Listing[], keep: (id: number) => boolean = id => chosen.has(id)) => ls.filter(l => keep(l.itemId)).map(l => [l.id, l.itemId, l.quantity, l.unitPrice ?? -1, ['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG'].indexOf(l.timeLeft)]);
const snapshots: Array<{ house: number; kind: string; at: number; listings: number[][]; yard: number[][] }> = [];
for (const [k, ls] of Object.entries(raw)) {
  const [h, kind] = k.split(':');
  snapshots.push({ house: Number(h), kind: kind!, at: (ls[0] as Listing & { publishedAt: number }).publishedAt, listings: pick(ls), yard: pick(ls, id => YARD.includes(id)) });
}
const inList = (xs: Iterable<number>) => [...xs].join(',');
const recipeIds = [...bgRecipes, ...YARD_RECIPES];
const out = {
  note: 'Cut by tests/e2e/fixtures/cut-goldens.ts from the 26 November raw snapshots of houses 111 and 116.',
  background: [...chosen].sort((a, b) => a - b),
  backgroundRecipes: bgRecipes,
  houses: db.prepare('SELECT * FROM houses WHERE id IN (111, 116)').all(),
  snapshots,
  items: db.prepare(`SELECT * FROM items WHERE id IN (${inList(items)})`).all(),
  recipes: db.prepare(`SELECT * FROM recipes WHERE id IN (${inList(recipeIds)})`).all(),
  recipe_reagents: db.prepare(`SELECT * FROM recipe_reagents WHERE recipe_id IN (${inList(recipeIds)})`).all(),
  // Bright Baubles: Old Man Heming alone, the yardstick's vendor. Every other item: its real Alliance and neutral vendors.
  vendor_items: (db.prepare(`SELECT * FROM vendor_items WHERE item_id IN (${inList(items)}) AND faction IN ('alliance', 'neutral')`).all() as Array<{ item_id: number; npc_name: string }>)
    .filter(v => v.item_id !== 6532 || v.npc_name === 'Old Man Heming'),
  trainer_spells: db.prepare(`SELECT * FROM trainer_spells WHERE faction IN ('alliance', 'neutral') AND spell_id IN (SELECT spell_id FROM recipes WHERE id IN (${inList(recipeIds)}))`).all(),
};
const buf = gzipSync(JSON.stringify(out), { level: 9 });
writeFileSync(new URL('./goldens.json.gz', import.meta.url), buf);
console.log(`background ${chosen.size} items, ${bgRecipes.length} real recipes, listings ${snapshots.map(s => s.listings.length).join('/')}, ${buf.length} bytes`);
