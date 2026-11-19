/**
 * Which house is mine? Pulls every Alliance and Blackwater house live and scores each one against what you saw
 * in game: floor price, total units available, and the full price ladder of one item. A ladder of many price steps
 * is a fingerprint no other house shares, so this works even if the floor moved since you looked.
 *
 * Usage: npm run match-house
 * Edit SEEN below with what the in game auction house shows (prices in copper, Available column = units).
 */
import { loadConfig } from '../src/config/env.ts';
import { BlizzardClient } from '../src/blizzard/client.ts';
import { HouseIndex, CommoditiesResponse } from '../src/blizzard/contracts.ts';
import { factionOf } from '../src/engine/houses.ts';

// From Chip's Stormwind screenshots, November 19.
const SEEN = {
  items: [
    { id: 2770, name: 'Copper Ore', floor: 97, units: 12017 },
    { id: 2589, name: 'Linen Cloth', floor: 26, units: 16788 },
    { id: 2592, name: 'Wool Cloth', floor: 165, units: 7367 },
    { id: 2840, name: 'Copper Bar', floor: 100, units: 9099 },
  ],
  ladderItem: 2592,
  ladder: [[165, 61], [170, 75], [171, 262], [177, 25], [178, 317], [179, 350], [180, 26], [185, 20], [188, 646], [189, 96],
    [190, 226], [192, 140], [193, 87], [194, 359], [197, 7], [198, 5], [199, 24], [200, 769], [217, 46]] as Array<[number, number]>,
};

const cfg = loadConfig();
const c = new BlizzardClient(cfg.clientId, cfg.clientSecret, cfg.region);
const index = await c.get(c.url('/data/wow/ruleset/2/auctions/', 'dynamic'), HouseIndex);
const houses = (index.body?.auctions ?? []).filter(h => factionOf(h.name) !== 'horde');

const rows: Array<{ id: number; faction: string; score: number; lines: string[] }> = [];
for (const h of houses) {
  const r = await c.get(c.url(`/data/wow/ruleset/2/auctions/${h.id}/commodities`, 'dynamic'), CommoditiesResponse);
  const listings = r.body?.auctions ?? [];
  if (!listings.length) { rows.push({ id: h.id, faction: factionOf(h.name), score: -1, lines: ['no commodity listings (dead house)'] }); continue; }
  const lines: string[] = [];
  let score = 0;
  for (const it of SEEN.items) {
    const mine = listings.filter(l => l.item.id === it.id);
    const floor = mine.length ? Math.min(...mine.map(l => l.unit_price)) : null;
    const units = mine.reduce((s, l) => s + l.quantity, 0);
    const unitsClose = units > 0 && Math.abs(units - it.units) / it.units <= 0.05;
    if (floor === it.floor) score += 1;
    if (unitsClose) score += 2;
    lines.push(`${it.name.padEnd(12)} floor ${String(floor ?? '-').padStart(5)}c (game ${it.floor}c)  units ${String(units).padStart(6)} (game ${it.units})${unitsClose ? '  units match' : ''}`);
  }
  // Ladder: how many of the price steps you saw exist here with the same units (within 10 percent).
  const ladder = new Map<number, number>();
  for (const l of listings) if (l.item.id === SEEN.ladderItem) ladder.set(l.unit_price, (ladder.get(l.unit_price) ?? 0) + l.quantity);
  const hits = SEEN.ladder.filter(([p, u]) => { const here = ladder.get(p); return here != null && Math.abs(here - u) <= Math.max(2, u * 0.1); }).length;
  score += hits;
  lines.push(`Wool Cloth ladder: ${hits} of ${SEEN.ladder.length} price steps match`);
  rows.push({ id: h.id, faction: factionOf(h.name), score, lines });
}

const max = 3 * SEEN.items.length + SEEN.ladder.length;
for (const r of rows.sort((a, b) => b.score - a.score)) {
  console.log(`\nHouse ${r.id} (${r.faction})  score ${r.score} of ${max}`);
  for (const l of r.lines) console.log(`  ${l}`);
}
const best = rows.filter(r => r.faction === 'alliance').sort((a, b) => b.score - a.score);
if (best[0] && best[0].score > (best[1]?.score ?? 0) * 2 && best[0].score >= max / 2) {
  console.log(`\nYour Alliance house is ${best[0].id}. Pick it in Settings, House finder.`);
} else {
  console.log('\nNo clear winner. Look again in game and update SEEN at the top of scripts/match-house.ts.');
}
console.log('Blackwater: do the same at Booty Bay, then put those numbers in SEEN and run again.\n');
