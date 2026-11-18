#!/usr/bin/env node
// WoW Forever: two questions that decide the whole project.
//   A. Is the auction feed actually Forever data, or another game version?
//   B. Can we walk professions down to recipes and reagents from the API?
// Usage: node probe.mjs       (reads .env in the same folder)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REGION = 'us';
const RULESET = 2;
const HOUSE = 110;

const raw = readFileSync(join(here, '.env'), 'utf8');
const env = {};
for (const line of raw.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i > -1) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const token = (await (await fetch('https://oauth.battle.net/token', {
  method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(`${env.BLIZZARD_CLIENT_ID}:${env.BLIZZARD_CLIENT_SECRET}`).toString('base64'),
             'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
})).json()).access_token;
if (!token) { console.error('Token failed.'); process.exit(1); }

const call = async (pathOrUrl, ns) => {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl
    : `https://${REGION}.api.blizzard.com${pathOrUrl}` + (pathOrUrl.includes('?') ? '&' : '?') + `namespace=${ns}-${REGION}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: res.ok ? await res.json() : null };
};
const nameOf = o => o?.name?.en_US ?? o?.name ?? null;

console.log('\n=== A. WHOSE AUCTION DATA IS THIS ================================\n');

const house = await call(`/data/wow/ruleset/${RULESET}/auctions/${HOUSE}`, 'dynamic-forever');
const listings = house.body?.auctions ?? [];
const counts = new Map();
for (const a of listings) {
  const id = a.item?.id; if (!id) continue;
  counts.set(id, (counts.get(id) ?? 0) + 1);
}
const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20);
const ids = [...counts.keys()];
console.log(`${listings.length.toLocaleString()} listings, ${counts.size.toLocaleString()} distinct items`);
console.log(`id range: ${Math.min(...ids)} to ${Math.max(...ids)}`);
console.log(`ids above 100000: ${ids.filter(i => i > 100000).length} of ${ids.length}\n`);
console.log('The 20 most listed items, resolved in both namespaces:\n');
console.log('   item id   listings   static-forever              static-us (retail)');

let foreverHits = 0, retailHits = 0;
for (const [id, n] of top) {
  const [f, r] = await Promise.all([
    call(`/data/wow/item/${id}`, 'static-forever'),
    call(`/data/wow/item/${id}`, 'static'),
  ]);
  const fn = f.status === 200 ? nameOf(f.body) : `(${f.status})`;
  const rn = r.status === 200 ? nameOf(r.body) : `(${r.status})`;
  if (f.status === 200) foreverHits++;
  if (r.status === 200) retailHits++;
  console.log(`   ${String(id).padStart(7)}   ${String(n).padStart(6)}   ${String(fn).padEnd(26)} ${rn}`);
}
console.log(`\n   resolved in static-forever: ${foreverHits}/20   in retail static: ${retailHits}/20`);

console.log('\n   Classic staples, are they listed anywhere in this house?');
for (const [id, label] of [[2589,'Linen Cloth'],[2770,'Copper Ore'],[2835,'Rough Stone'],[2592,'Wool Cloth'],[818,'Tigerseye']]) {
  console.log(`     ${label.padEnd(14)} ${counts.get(id) ?? 0} listings`);
}

console.log('\n=== B. PROFESSIONS AND RECIPES FROM THE API ======================\n');

const pIndex = await call('/data/wow/profession/index', 'static-forever');
const profs = pIndex.body?.professions ?? [];
console.log(`professions returned: ${profs.length}`);
console.log('  ' + profs.map(p => `${p.id} ${nameOf(p)}`).join('\n  '));

const bs = profs.find(p => /blacksmith/i.test(nameOf(p) ?? '')) ?? profs[0];
if (bs) {
  console.log(`\nwalking "${nameOf(bs)}" (id ${bs.id})`);
  const prof = await call(`/data/wow/profession/${bs.id}`, 'static-forever');
  const tiers = prof.body?.skill_tiers ?? [];
  console.log(`  skill tiers: ${tiers.length}  ${tiers.map(t => nameOf(t)).join(' | ')}`);

  if (tiers.length) {
    const tier = tiers[0];
    const st = await call(tier.key?.href ?? `/data/wow/profession/${bs.id}/skill-tier/${tier.id}`, 'static-forever');
    if (st.status !== 200) {
      console.log(`  skill tier fetch: ${st.status}`);
    } else {
      const cats = st.body?.categories ?? [];
      const recipes = cats.flatMap(c => c.recipes ?? []);
      console.log(`  categories: ${cats.length}, recipes in tier: ${recipes.length}`);
      console.log(`  first categories: ${cats.slice(0,4).map(c => nameOf(c)).join(' | ')}`);

      for (const r of recipes.slice(0, 3)) {
        const rec = await call(r.key?.href ?? `/data/wow/recipe/${r.id}`, 'static-forever');
        if (rec.status !== 200) { console.log(`\n  recipe ${r.id} ${nameOf(r)} -> ${rec.status}`); continue; }
        const b = rec.body;
        console.log(`\n  recipe ${b.id} ${nameOf(b)}`);
        console.log(`    crafted item: ${b.crafted_item ? `${b.crafted_item.id} ${nameOf(b.crafted_item)}` : 'none listed'}`);
        console.log(`    quantity: ${b.crafted_quantity?.value ?? '-'}`);
        for (const g of (b.reagents ?? [])) {
          console.log(`    reagent: ${g.quantity} x ${g.reagent?.id} ${nameOf(g.reagent)}`);
        }
        if (!b.reagents) console.log(`    keys present: ${Object.keys(b).join(', ')}`);
      }
    }
  }
}
console.log();
