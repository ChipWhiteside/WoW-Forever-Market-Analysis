/**
 * A deep commodity market with one seller who reprices by cancel and repost (round 2 system review, Clam Linguine:
 * a 313 unit stack pulled and 303 posted again 14 percent cheaper; 80 units "sold" while 86 came back cheaper).
 * Ten other sellers sit above him; real buyers take a few units an hour from the front. Every few hours he pulls
 * what is left of his stack and posts about as many units 8 to 15 percent cheaper. The pulled stack vanishes with a
 * whole stack behind it, so the counter reads it as bought. No snapshot signal tells this from buys followed by a
 * cheaper restock (B46), so the middle keeps it and the cautious estimate leaves such hours out (repricedRow).
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { rawPath, writeRaw } from '../../src/engine/rawstore.ts';
import { rebuildHistory } from '../../src/engine/rebuild.ts';
import { demandByItem, repricedRow } from '../../src/analysis/history.ts';
import type { Listing, TimeLeft } from '../../src/analysis/aggregate.ts';
import { rng, simulate } from './market.ts';
import { tempDir } from '../helpers.ts';

const T0 = Date.parse('2026-11-20T00:25:00Z');
const tl = (m: number): TimeLeft => m > 720 ? 'VERY_LONG' : m > 120 ? 'LONG' : m > 30 ? 'MEDIUM' : 'SHORT';

function load(snaps: Array<{ at: number; listings: Listing[] }>) {
  const dir = tempDir();
  const db = openDb(dir, ':memory:');
  for (const s of snaps) {
    const p = rawPath(dir, 111, 'commodities', s.at);
    writeRaw(p, s.listings);
    db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path) VALUES (111, 'commodities', ?, ?, ?, ?, 1, 1, ?)`)
      .run(new Date(s.at).toUTCString(), s.at, s.at, s.listings.length, p);
  }
  rebuildHistory(db);
  return db;
}

/** `every` hours the repricer pulls and posts again. Returns hourly snapshots and the units truly bought from listings
 * that were up at the previous snapshot (what a counter can see). */
function repricer(seed: number, hours: number, every: number, buyersPerHour: number) {
  const r = rng(seed);
  type L = { id: number; qty: number; price: number; posted: number; ends: number };
  const ls: L[] = [];
  let id = 1, last = -1, truth = 0;
  const post = (qty: number, price: number, t: number, mins: number) => { ls.push({ id: id++, qty, price, posted: t, ends: t + mins }); return id - 1; };
  for (let i = 0; i < 10; i++) post(20 + Math.floor(r() * 80), 3000 + i * 10, 0, 100_000);
  let price = 2799;
  let mine = post(600, price, 0, 1440);
  const snaps: Array<{ at: number; listings: Listing[] }> = [];
  for (let m = 0; m <= hours * 60; m++) {
    for (let i = ls.length - 1; i >= 0; i--) if (ls[i]!.ends <= m) ls.splice(i, 1);
    if (m % 60 === 0) { snaps.push({ at: T0 + m * 60_000, listings: ls.map(l => ({ id: l.id, itemId: 1, quantity: l.qty, unitPrice: l.price, timeLeft: tl(l.ends - m) })) }); last = m; }
    if (m % 60 === 30 && Math.floor(m / 60) % every === every - 1) {
      const i = ls.findIndex(l => l.id === mine);
      const left = i >= 0 ? ls.splice(i, 1)[0]!.qty : 0;
      price = Math.round(price * (0.9 + r() * 0.06));
      // A few units go elsewhere (mail, a split), the rest come back cheaper; never restocked.
      mine = post(Math.max(1, Math.round(left * (0.95 + r() * 0.05))), price, m, 1440);
    }
    if (r() < buyersPerHour / 60) {
      let q = 1 + Math.floor(r() * 8);
      ls.sort((a, b) => a.price - b.price || b.id - a.id);
      while (q > 0 && ls.length) { const l = ls[0]!; const x = Math.min(q, l.qty); l.qty -= x; q -= x; if (l.posted < last && m > 0) truth += x; if (l.qty === 0) ls.shift(); }
    }
  }
  return { snaps, truth };
}

describe('a deep commodity seller who reprices by cancel and repost', () => {
  it('the rule reads the Clam Linguine row and leaves a plain sale alone', () => {
    // Nov 24 06:25, house 111: 7 listings, floor 23s to 18s, 80 judged sold, 86 new near the floor.
    expect(repricedRow('commodities', 7, 2300, 1800, 80, 86)).toBe(true);
    expect(repricedRow('commodities', 7, 2300, 2300, 80, 86)).toBe(false); // the floor held
    expect(repricedRow('commodities', 7, 2300, 1800, 80, 20)).toBe(false); // far fewer units came back
    expect(repricedRow('commodities', 4, 2300, 1800, 80, 86)).toBe(false); // thin: its own rules
    expect(repricedRow('auctions', 40, 2300, 1800, 8, 8)).toBe(false);
  });

  it('the middle still reads the reposts, the cautious estimate leaves them out', () => {
    let lowOver = 0, middleOver = 0, flagged = 0, runs = 0;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const { snaps, truth } = repricer(seed, 48, 4, 2);
      const d = demandByItem(load(snaps), 111, { now: snaps[snaps.length - 1]!.at + 1 }).get(1)!;
      const truthPerDay = truth / 48 * 24;
      middleOver += d.unitsPerDay / truthPerDay; lowOver += d.lowPerDay! / truthPerDay; flagged += d.repricedHours!; runs++;
    }
    // 12 reprices in 48 hours, each reads as the whole stack bought: the middle runs about 10 times the truth.
    expect(middleOver / runs).toBeGreaterThan(5);
    expect(flagged / runs).toBeGreaterThanOrEqual(11);
    // Without the rule the low read 7.1 to 8.6 times the truth; with it 0.61 to 0.74 (cautious, under the truth).
    expect(lowOver / runs).toBeLessThan(1);
    expect(lowOver / runs).toBeGreaterThan(0.3);
  });

  it('a normal simulated deep market is rarely flagged and keeps most of its cautious estimate', () => {
    let flagged = 0, rows = 0, lowSum = 0;
    for (const seed of [201, 202, 203]) {
      const run = simulate({ type: 'deep', seed, hours: 48 });
      const d = demandByItem(load(run.snapshots), 111, { now: run.snapshots[run.snapshots.length - 1]!.at + 1 });
      for (const v of d.values()) { flagged += v.repricedHours ?? 0; rows += v.snapshots; lowSum += v.lowPerDay ?? 0; }
    }
    // 41 of 846 item hours flagged; the summed low fell 6.0 percent (20,526 to 19,297 a day) when the rule came in.
    expect(flagged / rows).toBeLessThan(0.06);
    expect(lowSum).toBeGreaterThan(19_000);
  });
});
