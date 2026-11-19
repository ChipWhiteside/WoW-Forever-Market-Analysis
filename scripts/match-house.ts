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

// From Chip's Stormwind screenshots, November 19. Ladders are [price in copper, units at that price].
const SEEN = {
  items: [
    { id: 2770, name: 'Copper Ore', floor: 95, units: 12508 },
    { id: 2589, name: 'Linen Cloth', floor: 27, units: 16252 },
    { id: 2840, name: 'Copper Bar', floor: 105, units: 8738 },
  ],
  ladders: {
    2770: [[95, 182], [96, 73], [97, 323], [98, 101], [99, 66], [100, 1112], [101, 12], [102, 352], [103, 142], [104, 32], [105, 1230],
      [106, 154], [107, 69], [108, 294], [109, 452], [110, 1100], [118, 460], [119, 352], [120, 39]],
    2589: [[27, 50], [28, 1105], [29, 5360], [30, 3542], [31, 254], [32, 66], [33, 175], [34, 212], [35, 214], [36, 61], [37, 95],
      [39, 26], [40, 251], [41, 12], [44, 174], [45, 60], [46, 40], [48, 86], [49, 20]],
    2840: [[105, 346], [106, 212], [107, 1261], [108, 451], [109, 72], [110, 921], [111, 117], [112, 424], [113, 651], [114, 94],
      [115, 222], [116, 56], [117, 280], [118, 913], [119, 60], [120, 875], [121, 20], [122, 34], [125, 452]],
  } as Record<number, Array<[number, number]>>,
};

const cfg = loadConfig();
const c = new BlizzardClient(cfg.clientId, cfg.clientSecret, cfg.region);
const index = await c.get(c.url('/data/wow/ruleset/2/auctions/', 'dynamic'), HouseIndex);
const houses = (index.body?.auctions ?? []).filter(h => factionOf(h.name) !== 'horde');

const rows: Array<{ id: number; faction: string; score: number; lines: string[] }> = [];
for (const h of houses) {
  let listings: Array<{ item: { id: number }; unit_price: number; quantity: number }> = [];
  try {
    const r = await c.get(c.url(`/data/wow/ruleset/2/auctions/${h.id}/commodities`, 'dynamic'), CommoditiesResponse);
    listings = r.body?.auctions ?? [];
  } catch (e) {
    rows.push({ id: h.id, faction: factionOf(h.name), score: -1, lines: [`could not read: ${(e as Error).message.slice(0, 160)}`] });
    continue;
  }
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
  // Ladders: how many of the price steps you saw exist here with the same units (within 10 percent).
  for (const it of SEEN.items) {
    const seen = SEEN.ladders[it.id];
    if (!seen) continue;
    const ladder = new Map<number, number>();
    for (const l of listings) if (l.item.id === it.id) ladder.set(l.unit_price, (ladder.get(l.unit_price) ?? 0) + l.quantity);
    const hits = seen.filter(([p, u]) => { const here = ladder.get(p); return here != null && Math.abs(here - u) <= Math.max(2, u * 0.1); }).length;
    score += hits;
    lines.push(`${it.name} ladder: ${hits} of ${seen.length} price steps match`);
  }
  rows.push({ id: h.id, faction: factionOf(h.name), score, lines });
}

const max = 3 * SEEN.items.length + Object.values(SEEN.ladders).reduce((n, l) => n + l.length, 0);
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
