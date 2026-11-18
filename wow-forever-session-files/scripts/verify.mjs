#!/usr/bin/env node
// WoW Forever: Blizzard API credential and endpoint verification.
// Usage: node verify.mjs      (reads .env in the same folder)
// Requires Node 18+. No dependencies.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REGION = 'us';
const RULESET = 2;          // Normal
const TEST_ITEM = 2589;     // Linen Cloth

function loadEnv() {
  let raw;
  try {
    raw = readFileSync(join(here, '.env'), 'utf8');
  } catch {
    fail('No .env file found next to this script. Create one with BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET.');
  }
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

function fail(msg) {
  console.error(`\nFAILED. ${msg}\n`);
  process.exit(1);
}

function ok(label, detail) {
  console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`);
}

async function getToken(id, secret) {
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`Token request returned ${res.status}. Blizzard said: ${body.slice(0, 300)}\n` +
         `Check the ID and secret in .env. A regenerated secret invalidates the old one.`);
  }
  const json = await res.json();
  if (!json.access_token) fail('Token response had no access_token.');
  return json;
}

async function get(token, path, namespace) {
  const url = `https://${REGION}.api.blizzard.com${path}` +
    (path.includes('?') ? '&' : '?') + `namespace=${namespace}-${REGION}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, url, body: res.ok ? await res.json() : await res.text() };
}

const env = loadEnv();
const id = env.BLIZZARD_CLIENT_ID;
const secret = env.BLIZZARD_CLIENT_SECRET;

if (!id || !secret) fail('.env is missing BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET.');
if (/paste|your_|here/i.test(secret)) fail('.env still has the placeholder secret in it.');

console.log('\nWoW Forever API verification');
console.log(`  client id ${id.slice(0, 6)}... , secret ${secret.length} chars\n`);

const tok = await getToken(id, secret);
ok('token', `expires in ${Math.round(tok.expires_in / 3600)}h`);

// 1. Rulesets
const rs = await get(tok.access_token, '/data/wow/ruleset/index', 'dynamic-forever');
if (rs.status !== 200) fail(`Ruleset index returned ${rs.status}. ${String(rs.body).slice(0, 200)}`);
const rulesets = rs.body.rulesets ?? rs.body.results ?? [];
ok('rulesets', rulesets.map(r => `${r.id} ${r.name?.en_US ?? r.name ?? ''}`.trim()).join(', ') || JSON.stringify(rs.body).slice(0, 200));

// 2. Auction house index. The trailing slash is required.
const ah = await get(tok.access_token, `/data/wow/ruleset/${RULESET}/auctions/`, 'dynamic-forever');
if (ah.status !== 200) fail(`House index returned ${ah.status}. The trailing slash is required. ${String(ah.body).slice(0, 200)}`);
const houses = ah.body.auctions ?? [];
ok('houses', `${houses.length} found`);
for (const h of houses) {
  console.log(`          ${String(h.id).padStart(3)}  ${h.name?.en_US ?? h.name ?? ''}`);
}

// 3. One Alliance house, to see real listings and size.
const alliance = houses.filter(h => /alliance/i.test(h.name?.en_US ?? h.name ?? ''));
if (alliance.length) {
  const h = alliance[0];
  const started = Date.now();
  const one = await get(tok.access_token, `/data/wow/ruleset/${RULESET}/auctions/${h.id}`, 'dynamic-forever');
  if (one.status === 200) {
    const a = one.body.auctions?.length ?? 0;
    const c = one.body.commodities?.length ?? 0;
    const mb = (Buffer.byteLength(JSON.stringify(one.body)) / 1048576).toFixed(1);
    ok(`house ${h.id}`, `${a} auctions, ${c} commodities, ${mb} MB, ${Date.now() - started}ms`);
  } else {
    console.log(`  WARN  house ${h.id} returned ${one.status}`);
  }
}

// 4. Static item data, which carries the vendor sell price.
const item = await get(tok.access_token, `/data/wow/item/${TEST_ITEM}`, 'static-forever');
if (item.status === 200) {
  ok('item 2589', `${item.body.name?.en_US ?? item.body.name}, sell ${item.body.sell_price}c, buy ${item.body.purchase_price}c`);
} else {
  console.log(`  WARN  item ${TEST_ITEM} returned ${item.status}. Expected for many ids, see the spec doc.`);
}

console.log('\nAll required checks passed. Credentials work and Forever is answering.\n');
