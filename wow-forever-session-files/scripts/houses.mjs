#!/usr/bin/env node
// WoW Forever: identify which Alliance auction house is yours.
// Usage: node houses.mjs      (reads .env in the same folder)
// Pulls every Alliance house and prints the floor price and depth for a few
// marker items. Open the auction house in game, search the same items, and
// the house whose numbers match is yours.
// Requires Node 18+. No dependencies. Downloads roughly 40 MB.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REGION = 'us';
const RULESET = 2;

// Marker items. High volume, easy to eyeball in game.
const MARKERS = {
  2770: 'Copper Ore',
  2589: 'Linen Cloth',
  2835: 'Rough Stone',
  2840: 'Copper Bar',
  2318: 'Light Leather',
};

function loadEnv() {
  const raw = readFileSync(join(here, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function money(copper) {
  if (copper == null) return '-';
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = Math.round(copper % 100);
  return (g ? `${g}g ` : '') + (g || s ? `${s}s ` : '') + `${c}c`;
}

const env = loadEnv();

const tokenRes = await fetch('https://oauth.battle.net/token', {
  method: 'POST',
  headers: {
    Authorization: 'Basic ' + Buffer.from(
      `${env.BLIZZARD_CLIENT_ID}:${env.BLIZZARD_CLIENT_SECRET}`).toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials',
});
const { access_token: token } = await tokenRes.json();
if (!token) { console.error('Token failed. Check .env.'); process.exit(1); }

const api = async (path) => {
  const res = await fetch(
    `https://${REGION}.api.blizzard.com${path}?namespace=dynamic-forever-${REGION}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : null;
};

const index = await api(`/data/wow/ruleset/${RULESET}/auctions/`);
const alliance = (index?.auctions ?? [])
  .filter(h => /alliance/i.test(h.name?.en_US ?? h.name ?? ''));

console.log(`\nAlliance houses under ruleset ${RULESET}: ${alliance.map(h => h.id).join(', ')}`);
console.log('Pulling each one. This downloads a few MB per house.\n');

for (const house of alliance) {
  const data = await api(`/data/wow/ruleset/${RULESET}/auctions/${house.id}`);
  const listings = data?.auctions ?? [];

  if (!listings.length) {
    console.log(`House ${house.id}   no auctions returned\n`);
    continue;
  }

  // Unit price, because a Classic style auction prices the whole stack.
  const best = {};
  for (const a of listings) {
    const id = a.item?.id;
    if (!MARKERS[id]) continue;
    const total = a.buyout ?? a.unit_price;
    if (!total) continue;                       // bid only, excluded
    const qty = a.quantity || 1;
    const unit = a.unit_price ? a.unit_price : Math.floor(total / qty);
    const b = best[id] ??= { unit: Infinity, units: 0, listings: 0 };
    if (unit < b.unit) { b.unit = unit; b.units = qty; b.listings = 1; }
    else if (unit === b.unit) { b.units += qty; b.listings++; }
  }

  console.log(`House ${house.id}   ${listings.length.toLocaleString()} auctions`);
  for (const [id, name] of Object.entries(MARKERS)) {
    const b = best[id];
    console.log(
      `   ${name.padEnd(14)} ` +
      (b ? `${money(b.unit).padStart(10)} per unit   ${String(b.units).padStart(5)} units at floor, ${b.listings} listings`
         : '      not listed'));
  }
  console.log();
}

console.log('Open the auction house in game, search these items, and compare the lowest');
console.log('buyout per unit. Match two of them before you trust the result.\n');
