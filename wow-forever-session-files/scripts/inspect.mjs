#!/usr/bin/env node
// WoW Forever: find out what the API actually returns, rather than assuming.
// Usage: node inspect.mjs      (reads .env in the same folder)
// Requires Node 18+. No dependencies.

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
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > -1) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const tokRes = await fetch('https://oauth.battle.net/token', {
  method: 'POST',
  headers: {
    Authorization: 'Basic ' + Buffer.from(
      `${env.BLIZZARD_CLIENT_ID}:${env.BLIZZARD_CLIENT_SECRET}`).toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials',
});
const token = (await tokRes.json()).access_token;
if (!token) { console.error('Token failed.'); process.exit(1); }

const call = async (path, ns) => {
  const url = `https://${REGION}.api.blizzard.com${path}` +
    (path.includes('?') ? '&' : '?') + `namespace=${ns}-${REGION}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: res.ok ? await res.json() : (await res.text()).slice(0, 160) };
};

console.log('\n=== 1. SHAPE OF AN AUCTION ENTRY =================================\n');

const house = await call(`/data/wow/ruleset/${RULESET}/auctions/${HOUSE}`, 'dynamic-forever');
console.log('top level keys:', Object.keys(house.body).join(', '));

const listings = house.body.auctions ?? [];
console.log(`auctions array length: ${listings.length}\n`);
console.log('first three entries, verbatim:\n');
for (const a of listings.slice(0, 3)) console.log(JSON.stringify(a));

console.log('\n=== 2. WHERE THE ITEM ID LIVES ===================================\n');

const probes = {
  'a.item.id':  a => (a.item && typeof a.item === 'object') ? a.item.id : undefined,
  'a.item':     a => (typeof a.item === 'number') ? a.item : undefined,
  'a.item_id':  a => a.item_id,
  'a.itemId':   a => a.itemId,
  'a.id':       a => a.id,
};
const sample = listings.slice(0, 5000);
for (const [label, fn] of Object.entries(probes)) {
  const vals = sample.map(fn).filter(v => typeof v === 'number');
  const distinct = new Set(vals).size;
  console.log(`  ${label.padEnd(12)} ${String(vals.length).padStart(5)} hits in 5000, ${distinct} distinct`);
}

console.log('\n=== 3. IS LINEN CLOTH (2589) IN THERE ============================\n');
let found = 0, example = null;
for (const a of listings) {
  const id = (a.item && typeof a.item === 'object') ? a.item.id
           : (typeof a.item === 'number') ? a.item
           : a.item_id ?? a.itemId;
  if (id === 2589) { found++; example ??= a; }
}
console.log(`  listings of item 2589: ${found}`);
if (example) console.log(`  example: ${JSON.stringify(example)}`);

console.log('\n=== 4. PRICE AND QUANTITY FIELDS PRESENT =========================\n');
const fields = {};
for (const a of sample) for (const k of Object.keys(a)) fields[k] = (fields[k] ?? 0) + 1;
for (const [k, n] of Object.entries(fields).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${k.padEnd(14)} present on ${n} of ${sample.length}`);
}
const hasSeller = Object.keys(fields).some(k => /seller|owner|character|player/i.test(k));
console.log(`\n  seller identity field present: ${hasSeller ? 'YES' : 'NO'}`);

console.log('\n=== 5. CAN WE GET RECIPES FROM THE API ===========================\n');
for (const [label, path, ns] of [
  ['profession index',  '/data/wow/profession/index',      'static-forever'],
  ['profession 164',    '/data/wow/profession/164',        'static-forever'],
  ['recipe 2738',       '/data/wow/recipe/2738',           'static-forever'],
  ['item classes',      '/data/wow/item-class/index',      'static-forever'],
  ['item search',       '/data/wow/search/item?_page=1',   'static-forever'],
]) {
  const r = await call(path, ns);
  const note = r.status === 200
    ? Object.keys(r.body).slice(0, 8).join(', ')
    : String(r.body).replace(/\s+/g, ' ').slice(0, 90);
  console.log(`  ${label.padEnd(18)} ${r.status}  ${note}`);
}

console.log('\n=== 6. VENDOR PRICES ON A FEW KNOWN ITEMS ========================\n');
for (const [id, name] of [[2589,'Linen Cloth'],[2770,'Copper Ore'],[2840,'Copper Bar'],[6358,'Oily Blackmouth'],[6289,'Raw Longjaw Mud Snapper']]) {
  const r = await call(`/data/wow/item/${id}`, 'static-forever');
  if (r.status === 200) {
    console.log(`  ${String(id).padEnd(6)} ${(r.body.name?.en_US ?? r.body.name ?? '?').padEnd(26)} sell ${String(r.body.sell_price).padStart(6)}c   buy ${String(r.body.purchase_price).padStart(7)}c`);
  } else {
    console.log(`  ${String(id).padEnd(6)} ${r.status}`);
  }
}
console.log();
