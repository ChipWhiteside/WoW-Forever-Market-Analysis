#!/usr/bin/env node
// WoW Forever: how often does the data actually change, and is the ruleset
// path segment real? Runs for about five minutes.
// Usage: node cadence.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const REGION = 'us';
const POLLS = 6, GAP_MS = 60_000;

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

const call = async (p, extraHeaders = {}) => {
  const res = await fetch(`https://${REGION}.api.blizzard.com${p}?namespace=dynamic-forever-${REGION}`,
    { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } });
  return { status: res.status, lastModified: res.headers.get('last-modified'),
           body: res.status === 200 ? await res.json() : null };
};
const rowsOf = b => b?.auctions ?? b?.commodities ?? [];
const idSet = rows => new Set(rows.map(r => r.id));
const floorOf = (rows, itemId) => {
  let f = null;
  for (const r of rows) {
    if ((r.item?.id ?? r.item) !== itemId) continue;
    const u = r.unit_price ?? (r.buyout ? Math.floor(r.buyout / (r.quantity || 1)) : null);
    if (u != null && (f == null || u < f)) f = u;
  }
  return f;
};

console.log('\n=== B1. IS THE RULESET SEGMENT REAL? ============================');
console.log('    Strict test: compare the actual sets of auction ids, not counts.\n');

const r1 = await call('/data/wow/ruleset/1/auctions/110/commodities');
const r2 = await call('/data/wow/ruleset/2/auctions/110/commodities');
const s1 = idSet(rowsOf(r1.body)), s2 = idSet(rowsOf(r2.body));
let shared = 0; for (const id of s1) if (s2.has(id)) shared++;
const union = s1.size + s2.size - shared;
console.log(`    ruleset 1: ${s1.size.toLocaleString()} ids, last-modified ${r1.lastModified}`);
console.log(`    ruleset 2: ${s2.size.toLocaleString()} ids, last-modified ${r2.lastModified}`);
console.log(`    shared ids: ${shared.toLocaleString()}  (${(100 * shared / union).toFixed(3)}% of the union)`);
console.log(`    only in 1: ${s1.size - shared}    only in 2: ${s2.size - shared}`);
console.log(`\n    READING: ${shared / union > 0.99
  ? 'the same market. The ruleset path segment is cosmetic and the house id is the market.'
  : 'genuinely different id sets. The ruleset segment selects a real market.'}`);

console.log('\n=== B2. DOES THE DATA CHANGE FASTER THAN HOURLY? ================');
console.log(`    ${POLLS} polls, ${GAP_MS / 1000}s apart, house 110 commodities.`);
console.log('    Watching Last-Modified, the id set, and the Copper Ore floor.\n');
console.log('    time      last-modified                    rows     copper   new ids  gone ids  304?');

let prevSet = null, prevLM = null;
for (let i = 0; i < POLLS; i++) {
  if (i) await new Promise(r => setTimeout(r, GAP_MS));

  // Conditional request, to see whether If-Modified-Since is honoured at all.
  const cond = prevLM ? await call('/data/wow/ruleset/2/auctions/110/commodities',
                                   { 'If-Modified-Since': prevLM }) : null;
  const got304 = cond ? (cond.status === 304 ? 'YES' : `no (${cond.status})`) : '-';

  const res = await call('/data/wow/ruleset/2/auctions/110/commodities');
  const rows = rowsOf(res.body);
  const set = idSet(rows);
  let added = '-', gone = '-';
  if (prevSet) {
    added = 0; gone = 0;
    for (const id of set) if (!prevSet.has(id)) added++;
    for (const id of prevSet) if (!set.has(id)) gone++;
  }
  const clock = new Date().toISOString().slice(11, 19);
  console.log(`    ${clock}  ${String(res.lastModified).padEnd(32)} ${String(rows.length).padStart(7)}  ${String(floorOf(rows, 2770) ?? '-').padStart(6)}c  ${String(added).padStart(7)}  ${String(gone).padStart(8)}  ${got304}`);
  prevSet = set;
  prevLM = res.lastModified;
}

console.log('\n    If Last-Modified advances every poll and ids keep churning, the feed is');
console.log('    live rather than hourly, If-Modified-Since is useless, and polling');
console.log('    cadence becomes our choice rather than Blizzard\'s.\n');
