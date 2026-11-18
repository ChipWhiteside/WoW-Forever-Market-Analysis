#!/usr/bin/env node
// WoW Forever: test the things we currently believe but have never proven.
// Usage: node assumptions.mjs      (reads .env in the same folder)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REGION = 'us';

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

const call = async (p) => {
  const res = await fetch(`https://${REGION}.api.blizzard.com${p}?namespace=dynamic-forever-${REGION}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return {
    status: res.status,
    lastModified: res.headers.get('last-modified'),
    date: res.headers.get('date'),
    body: res.ok ? await res.json() : null,
  };
};
const rowsOf = b => b?.auctions ?? b?.commodities ?? [];

console.log('\n=== A1. "buyout prices the whole stack, divide by quantity" =======');
console.log('    Claimed as rule one of the build. Never actually tested.\n');
const a = await call('/data/wow/ruleset/2/auctions/110');
const auctions = rowsOf(a.body);
const qty = {};
for (const r of auctions) qty[r.quantity] = (qty[r.quantity] ?? 0) + 1;
const multi = auctions.filter(r => (r.quantity ?? 1) > 1);
console.log(`    ${auctions.length.toLocaleString()} equipment auctions`);
console.log('    quantity distribution:', Object.entries(qty).sort((x,y)=>Number(x[0])-Number(y[0])).slice(0,8).map(([k,v])=>`${k}x${v}`).join('  '));
console.log(`    listings with quantity > 1: ${multi.length}`);
if (multi.length) {
  console.log('    examples:'); for (const m of multi.slice(0,3)) console.log('      ' + JSON.stringify(m));
} else {
  console.log('    VERDICT: every equipment auction is quantity 1, so the division');
  console.log('    is untestable here and the rule is unproven, not confirmed.');
}
const hasUnit = auctions.filter(r => r.unit_price != null).length;
console.log(`    equipment auctions carrying unit_price: ${hasUnit}`);

console.log('\n=== A2. Does the ruleset in the path change anything? =============');
console.log('    If not, the house id is the only thing that selects a market.\n');
const sets = [1, 2, 3, 15];
const fingerprints = {};
for (const rs of sets) {
  const c = await call(`/data/wow/ruleset/${rs}/auctions/110/commodities`);
  const rows = rowsOf(c.body);
  let copper = null;
  for (const r of rows) if ((r.item?.id ?? r.item) === 2770) {
    const u = r.unit_price ?? Math.floor(r.buyout / (r.quantity || 1));
    if (copper == null || u < copper) copper = u;
  }
  fingerprints[rs] = `${rows.length} rows, copper floor ${copper}c`;
  console.log(`    ruleset ${String(rs).padStart(2)} house 110  ${fingerprints[rs]}   last-modified ${c.lastModified ?? 'none'}`);
}
const distinct = new Set(Object.values(fingerprints)).size;
console.log(`\n    VERDICT: ${distinct === 1
  ? 'identical across rulesets. The ruleset path segment is cosmetic.'
  : 'rulesets differ. The path segment selects a real market.'}`);

console.log('\n=== A3. Is Last-Modified present, and does it drive polling? ======\n');
for (const p of ['/data/wow/ruleset/2/auctions/110',
                 '/data/wow/ruleset/2/auctions/110/commodities',
                 '/data/wow/ruleset/2/auctions/']) {
  const r = await call(p);
  console.log(`    ${p.padEnd(48)} last-modified: ${r.lastModified ?? 'NONE'}`);
}

console.log('\n=== A4. Why did the auction count swing 86,724 -> 80,126 -> 133,458?');
console.log('    Two pulls back to back. Same snapshot should give the same count.\n');
const p1 = await call('/data/wow/ruleset/2/auctions/110');
const p2 = await call('/data/wow/ruleset/2/auctions/110');
console.log(`    pull 1: ${rowsOf(p1.body).length.toLocaleString()} rows, last-modified ${p1.lastModified ?? 'none'}`);
console.log(`    pull 2: ${rowsOf(p2.body).length.toLocaleString()} rows, last-modified ${p2.lastModified ?? 'none'}`);
console.log(`    VERDICT: ${rowsOf(p1.body).length === rowsOf(p2.body).length
  ? 'stable within a snapshot.'
  : 'UNSTABLE. The same endpoint returns different data on consecutive calls.'}`);

console.log('\n=== A5. What are the five Alliance houses? ========================');
console.log('    Hypothesis: one per ruleset, 110 and 111 being the big ones.\n');
for (const id of [110, 111, 112, 119, 123]) {
  const c = await call(`/data/wow/ruleset/2/auctions/${id}/commodities`);
  const rows = rowsOf(c.body);
  let copper = null, linen = null;
  for (const r of rows) {
    const iid = r.item?.id ?? r.item;
    const u = r.unit_price ?? (r.buyout ? Math.floor(r.buyout / (r.quantity || 1)) : null);
    if (u == null) continue;
    if (iid === 2770 && (copper == null || u < copper)) copper = u;
    if (iid === 2589 && (linen == null || u < linen)) linen = u;
  }
  console.log(`    house ${id}  ${String(rows.length).padStart(7)} rows   copper ${String(copper ?? '-').padStart(5)}c   linen ${String(linen ?? '-').padStart(5)}c   modified ${c.lastModified ?? 'none'}`);
}
console.log();
