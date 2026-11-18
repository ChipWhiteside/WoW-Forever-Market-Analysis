/**
 * Replay the detectors over stored raw snapshots and compare with the saved goldens.
 * The tester uses this to prove a change did not move any play it was not meant to move.
 *   npx tsx scripts/replay.ts record   save today's output as the golden
 *   npx tsx scripts/replay.ts check    compare, exit 1 on any difference
 */
import { readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/env.ts';
import { openDb } from '../src/store/db.ts';
import { readRaw } from '../src/engine/rawstore.ts';
import { itemsFor, allianceVendors } from '../src/engine/context.ts';
import { vendorDump } from '../src/detectors/vendorDump.ts';
import { vendorSupply } from '../src/detectors/vendorSupply.ts';
import { crossHouse } from '../src/detectors/crossHouse.ts';
import type { DetectorContext, HouseCtx } from '../src/detectors/types.ts';
import type { Listing } from '../src/analysis/aggregate.ts';

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const mode = process.argv[2] ?? 'check';
const rawRoot = join(cfg.dataDir, 'raw');
if (!existsSync(rawRoot)) { console.log('no raw snapshots yet, nothing to replay'); process.exit(0); }
const latest = new Map<number, string[]>();
for (const day of readdirSync(rawRoot).sort()) for (const f of readdirSync(join(rawRoot, day)).sort()) {
  const [house, kind] = f.split('-');
  const arr = latest.get(Number(house)) ?? [];
  latest.set(Number(house), [...arr.filter(p => !p.includes(`-${kind}-`)), join(rawRoot, day, f)]);
}
const houses = db.prepare('SELECT * FROM houses WHERE tracked = 1').all() as Array<{ id: number; name: string; faction: HouseCtx['faction']; cut: number; pinned: number }>;
const listings = new Map<number, Listing[]>();
const ctxHouses: HouseCtx[] = [];
for (const h of houses) {
  const files = latest.get(h.id);
  if (!files) continue;
  listings.set(h.id, files.flatMap(f => readRaw(f)));
  ctxHouses.push({ id: h.id, name: h.name, faction: h.faction, cut: h.cut, pinned: !!h.pinned, publishedAt: 0 });
}
const ids = new Set([...listings.values()].flat().map(l => l.itemId));
const ctx: DetectorContext = { houses: ctxHouses, listings, items: itemsFor(db, ids), vendors: allianceVendors(db), demand: new Map(), now: 0 };
const out = [...vendorDump(ctx), ...vendorSupply(ctx), ...crossHouse(ctx)].map(p => `${p.key} ${p.profit}`).sort();
const goldFile = join(cfg.dataDir, 'replay-golden.txt');
if (mode === 'record') { writeFileSync(goldFile, out.join('\n')); console.log(`recorded ${out.length} plays as golden`); process.exit(0); }
if (!existsSync(goldFile)) { console.log('no golden yet, run: npx tsx scripts/replay.ts record'); process.exit(0); }
const gold = readFileSync(goldFile, 'utf8').split('\n').filter(Boolean);
const added = out.filter(x => !gold.includes(x)), removed = gold.filter(x => !out.includes(x));
console.log(`replay: ${out.length} plays, ${added.length} new, ${removed.length} gone vs golden`);
for (const x of added.slice(0, 20)) console.log(`  + ${x}`);
for (const x of removed.slice(0, 20)) console.log(`  - ${x}`);
process.exit(added.length || removed.length ? 1 : 0);
