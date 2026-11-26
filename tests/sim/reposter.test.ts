/**
 * One dominant seller holds the front: 5 stacks of 20 at the floor, pulled and posted again every hour, while 3 real
 * buyers an hour take a few units each. Every publish the whole front has vanished with nothing ahead of it still up,
 * so the counter reads it as bought: the middle runs 11 to 14 times the truth (round 2 test). No snapshot field tells
 * a pull from a buy, so the item is flagged (frontReplacedHourly) and its cautious estimate withheld.
 * A normal simulated deep market, run through the same database path, must not be flagged.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { rawPath, writeRaw } from '../../src/engine/rawstore.ts';
import { rebuildHistory } from '../../src/engine/rebuild.ts';
import { demandByItem } from '../../src/analysis/history.ts';
import type { Listing, TimeLeft } from '../../src/analysis/aggregate.ts';
import { rng, simulate } from './market.ts';
import { tempDir } from '../helpers.ts';

const H = 3600_000;
const T0 = Date.parse('2026-11-20T00:25:00Z');

function load(snaps: Array<{ at: number; listings: Listing[] }>, kind: 'commodities' | 'auctions' = 'commodities') {
  const dir = tempDir();
  const db = openDb(dir, ':memory:');
  for (const s of snaps) {
    const path = rawPath(dir, 111, kind, s.at);
    writeRaw(path, s.listings);
    db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path) VALUES (111, ?, ?, ?, ?, ?, 1, 1, ?)`)
      .run(kind, new Date(s.at).toUTCString(), s.at, s.at, s.listings.length, path);
  }
  rebuildHistory(db);
  return db;
}

/** The reposter market, minute by minute for `hours`, snapshot each hour. Returns snapshots and true units bought. */
function reposter(hours: number) {
  const r = rng(7);
  type L = { id: number; qty: number; price: number; posted: number; ends: number };
  const ls: L[] = [];
  let id = 1, last = -1, truth = 0;
  const post = (qty: number, price: number, t: number, mins: number) => ls.push({ id: id++, qty, price, posted: t, ends: t + mins });
  for (let i = 0; i < 60; i++) post(20, 100 + i, 0, 100_000);
  for (let i = 0; i < 5; i++) post(20, 95, 0, 480);
  const snaps: Array<{ at: number; listings: Listing[] }> = [];
  const tl = (m: number): TimeLeft => m > 720 ? 'VERY_LONG' : m > 120 ? 'LONG' : m > 30 ? 'MEDIUM' : 'SHORT';
  for (let m = 0; m <= hours * 60; m++) {
    if (m % 60 === 0) {
      snaps.push({ at: T0 + m * 60_000, listings: ls.filter(l => l.qty > 0).map(l => ({ id: l.id, itemId: 1, quantity: l.qty, unitPrice: l.price, timeLeft: tl(l.ends - m) })) });
      last = m;
    }
    if (r() < 1 / 10) post(20, 100 + Math.floor(r() * 60), m, 100_000);
    if (m % 60 === 30) { for (let i = ls.length - 1; i >= 0; i--) if (ls[i]!.price === 95) ls.splice(i, 1); for (let i = 0; i < 5; i++) post(20, 95, m, 480); }
    if (r() < 3 / 60) {
      let q = 1 + Math.floor(-Math.log(1 - r()) * 5);
      ls.sort((a, b) => a.price - b.price || b.id - a.id);
      while (q > 0 && ls.length) { const l = ls[0]!; const x = Math.min(q, l.qty); l.qty -= x; q -= x; if (l.posted < last && m > 0) truth += x; if (l.qty === 0) ls.shift(); }
    }
  }
  return { snaps, truth };
}

describe('a dominant seller who pulls and posts the front again every hour', () => {
  it('reads as many times the real sales, so the item is flagged and no cautious figure is given', () => {
    const { snaps, truth } = reposter(24);
    const db = load(snaps);
    const d = demandByItem(db, 111, { now: snaps[snaps.length - 1]!.at + 1 }).get(1)!;
    expect(d.soldUnits! / truth).toBeGreaterThan(5); // the leak this guards against
    expect(d.frontReplacedHourly).toBe(true);
    expect(d.lowPerDay).toBeNull();
    expect(d.lowNote).toMatch(/replaced every hour/);
  });

  it('a normal simulated deep market and equipment market are never flagged', () => {
    for (const type of ['deep', 'equipment'] as const) {
      const run = simulate({ type, seed: 211, hours: 48 });
      const db = load(run.snapshots, run.commodity ? 'commodities' : 'auctions');
      const d = demandByItem(db, 111, { now: run.snapshots[run.snapshots.length - 1]!.at + 1 });
      expect(d.size).toBeGreaterThan(0);
      for (const v of d.values()) { expect(v.frontReplacedHourly).toBe(false); expect(v.lowPerDay).not.toBeNull(); }
    }
  });
});
