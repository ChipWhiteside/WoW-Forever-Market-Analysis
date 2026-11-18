#!/usr/bin/env node
// WoW Forever: the other half of the market, plus house identification.
// Usage: node commodities.mjs      (reads .env in the same folder)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REGION = 'us', RULESET = 2;

const MARKERS = {
  2770: 'Copper Ore', 2840: 'Copper Bar', 2835: 'Rough Stone',
  2589: 'Linen Cloth', 2592: 'Wool Cloth', 2318: 'Light Leather',
  2771: 'Tin Ore',     3356: 'Kingsblood', 2447: 'Peacebloom',
};

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
  return { status: res.status, body: res.ok ? await res.json() : null };
};
const money = c => {
  if (c == null) return '-';
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = Math.round(c % 100);
  return (g ? `${g}g ` : '') + (g || s ? `${s}s ` : '') + `${cc}c`;
};

console.log('\n=== WHAT THE commodities KEY ACTUALLY IS ========================\n');
const h = await call(`/data/wow/ruleset/${RULESET}/auctions/110`);
console.log('  house.commodities =', JSON.stringify(h.body?.commodities));
console.log('  house.auctions is an array of', (h.body?.auctions ?? []).length);

console.log('\n=== SHAPE OF A COMMODITY ENTRY ==================================\n');
const probe = await call(`/data/wow/ruleset/${RULESET}/auctions/110/commodities`);
console.log(`  status ${probe.status}`);
if (probe.status === 200) {
  console.log('  top level keys:', Object.keys(probe.body).join(', '));
  const rows = probe.body.commodities ?? probe.body.auctions ?? [];
  console.log(`  entries: ${rows.length.toLocaleString()}\n`);
  for (const r of rows.slice(0, 3)) console.log('  ' + JSON.stringify(r));
}

console.log('\n=== EVERY ALLIANCE HOUSE, RAW MATERIAL FLOORS ===================\n');

const index = await call(`/data/wow/ruleset/${RULESET}/auctions/`);
const alliance = (index.body?.auctions ?? []).filter(x => /alliance/i.test(x.name?.en_US ?? x.name ?? ''));

for (const house of alliance) {
  const c = await call(`/data/wow/ruleset/${RULESET}/auctions/${house.id}/commodities`);
  if (c.status !== 200) { console.log(`House ${house.id}   commodities ${c.status}\n`); continue; }
  const rows = c.body.commodities ?? c.body.auctions ?? [];

  const best = {};
  for (const r of rows) {
    const id = r.item?.id ?? r.item;
    if (!MARKERS[id]) continue;
    const qty = r.quantity || 1;
    const unit = r.unit_price ?? (r.buyout ? Math.floor(r.buyout / qty) : null);
    if (unit == null) continue;
    const b = best[id] ??= { unit: Infinity, atFloor: 0, listings: 0, total: 0 };
    b.total += qty;
    if (unit < b.unit) { b.unit = unit; b.atFloor = qty; b.listings = 1; }
    else if (unit === b.unit) { b.atFloor += qty; b.listings++; }
  }

  console.log(`House ${house.id}   ${rows.length.toLocaleString()} commodity listings`);
  for (const [id, name] of Object.entries(MARKERS)) {
    const b = best[id];
    console.log(`   ${name.padEnd(13)} ` + (b
      ? `${money(b.unit).padStart(9)} /unit   ${String(b.atFloor).padStart(5)} at floor (${b.listings} listings)   ${String(b.total).padStart(6)} total units`
      : '    not listed'));
  }
  console.log();
}

console.log('Open the auction house in game. Search Copper Ore and Linen Cloth.');
console.log('Compare the lowest price per unit. The house that matches both is yours.\n');
