/**
 * Run the flip engine once over the latest stored snapshots of Chip's houses and print the ranked list.
 *   DATA_DIR=... npx tsx src/flips/cli.ts [--top 25] [--persist] [--json out.json]
 * Listings come from the raw snapshots the collector keeps (the same files Collector.restore reads).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../store/db.ts';
import { rawPath, readRaw } from '../engine/rawstore.ts';
import type { Listing } from '../analysis/aggregate.ts';
import { money } from '../format/money.ts';
import { chipHouses } from './houses.ts';
import { buildFlipInputs } from './inputs.ts';
import { runFlips } from './run.ts';
import { persistFlips } from './persist.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const dataDir = process.env.DATA_DIR || join(homedir(), '.wowf-gold-finder');
const db = openDb(dataDir);
const now = Number(arg('--now')) || Date.now();
const listings = new Map<number, Listing[]>();
for (const h of chipHouses(db)) {
  const ls: Listing[] = [];
  for (const kind of ['auctions', 'commodities']) {
    const row = db.prepare('SELECT published_at FROM snapshots WHERE house_id = ? AND kind = ? ORDER BY published_at DESC LIMIT 1').get(h.id, kind) as { published_at: number } | undefined;
    if (!row) continue;
    const p = rawPath(dataDir, h.id, kind, row.published_at);
    if (existsSync(p)) for (const l of readRaw(p)) ls.push(l);
  }
  if (ls.length) listings.set(h.id, ls);
}
const t0 = Date.now();
const inputs = buildFlipInputs(db, listings, now);
const t1 = Date.now();
const res = runFlips(inputs);
console.log(`inputs ${t1 - t0} ms, run ${res.report.ms} ms, complete ${res.report.complete}${res.report.incompleteReason ? ` (${res.report.incompleteReason})` : ''}`);
console.log(`houses ${res.report.houses.join(', ')}; items ${res.report.items}; recipes ${res.report.recipesTried}; flips ${res.report.flips}`);
console.log('by family', res.report.byFamily);
console.log('held back', res.report.heldBackByReason);
console.log('suspects', res.report.suspects);
const top = Number(arg('--top') ?? 25);
for (const f of res.flips.slice(0, top)) {
  const b = f.best, q = f.sellQuote;
  console.log(`#${f.rank} [${f.kind}] ${f.family} ${f.name}${f.recipeName ? ` (${f.recipeName})` : ''} sell ${f.sellHouseId ?? 'vendor'}: expected ${money(b.expectedProfit)} at ${b.units}, each ${money(f.perItem)}, cost ${money(b.cost)}, sold ${b.expectedSold}, ${b.minutes} min, risk ${b.risk.level} (bad ${money(b.risk.badCaseLoss)})`);
  console.log(`   claim ${money(q.claimPrice)} post ${money(q.undercutPrice)} net ${money(q.netEach)} basis ${q.basis} listed ${money(q.listed)} low/day ${q.salesPerDayLow?.toFixed(2)} mid/day ${q.salesPerDayMid?.toFixed(2)} hours ${q.hoursWatched} new/h ${q.newPerHour.toFixed(2)} strength ${q.strength} cv ${q.cv?.toFixed(3)}`);
  console.log(`   buy: ${f.buy.map(l => `${l.units}x ${l.name} @ ${money(l.unitPrice)} (${l.kind} ${l.who})`).join('; ')}`);
  console.log(`   options: ${f.options.map(o => `${o.label} ${o.units}: cost ${money(o.cost)} exp ${money(o.expectedProfit)} sold ${o.expectedSold} risk ${o.risk.level}`).join(' | ')}`);
  console.log(`   after shared: ${f.afterShared?.units} units ${money(f.afterShared?.expectedProfit)}${f.shares.length ? `, shares with ${f.shares.join(', ')}` : ''}; ${f.repeatable ? 'repeatable' : 'one opening'}; ${f.notes.join(' | ')}`);
}
if (arg('--json')) writeFileSync(arg('--json')!, JSON.stringify(res, null, 1));
if (process.argv.includes('--persist')) console.log('persist', persistFlips(db, res, now));
