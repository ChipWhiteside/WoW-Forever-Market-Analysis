/**
 * Repost churn with no buyer at all, through the real database path (round 3 test, findings in
 * scratchpad/findings-sale-counting-r3-fixes.txt). Every shape here reads as sales unless the counter sees the repost:
 * before the round 3 fixes the low read 48 a day for a floor seller repricing on a deep equipment market, 48 for a
 * thin reprice of more than 25 percent, 5.5 and 69 for a repost across a publish, and 679 for a thin commodity
 * posted again in other stack sizes. The truth is 0 in every case.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { rawPath, writeRaw } from '../../src/engine/rawstore.ts';
import { rebuildHistory } from '../../src/engine/rebuild.ts';
import { demandByItem } from '../../src/analysis/history.ts';
import type { Listing, TimeLeft } from '../../src/analysis/aggregate.ts';
import { tempDir } from '../helpers.ts';

const T0 = Date.parse('2026-11-20T00:25:00Z');
const tl = (m: number): TimeLeft => m > 720 ? 'VERY_LONG' : m > 120 ? 'LONG' : m > 30 ? 'MEDIUM' : 'SHORT';
type L = { id: number; item: number; qty: number; price: number; ends: number };
type Post = (item: number, qty: number, price: number, m: number, mins?: number) => number;

function load(snaps: Array<{ at: number; listings: Listing[] }>, kind: 'commodities' | 'auctions') {
  const dir = tempDir();
  const db = openDb(dir, ':memory:');
  for (const s of snaps) {
    const p = rawPath(dir, 111, kind, s.at);
    writeRaw(p, s.listings);
    db.prepare(`INSERT INTO snapshots (house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes, raw_path) VALUES (111, ?, ?, ?, ?, ?, 1, 1, ?)`)
      .run(kind, new Date(s.at).toUTCString(), s.at, s.at, s.listings.length, p);
  }
  rebuildHistory(db);
  return db;
}

/** Minute by minute: `act` each minute, a snapshot every hour. */
function run(hours: number, init: (post: Post) => void, act: (m: number, ls: L[], post: Post, pull: (id: number) => void) => void) {
  let id = 1;
  const ls: L[] = [];
  const post: Post = (item, qty, price, m, mins = 1440) => { ls.push({ id, item, qty, price, ends: m + mins }); return id++; };
  const pull = (x: number) => { const i = ls.findIndex(l => l.id === x); if (i >= 0) ls.splice(i, 1); };
  init(post);
  const snaps: Array<{ at: number; listings: Listing[] }> = [];
  for (let m = 0; m <= hours * 60; m++) {
    for (let i = ls.length - 1; i >= 0; i--) if (ls[i]!.ends <= m) ls.splice(i, 1);
    if (m % 60 === 0) snaps.push({ at: T0 + m * 60_000, listings: ls.map(l => ({ id: l.id, itemId: l.item, quantity: l.qty, unitPrice: l.price, timeLeft: tl(l.ends - m) })) });
    act(m, ls, post, pull);
  }
  return snaps;
}

const P = 4_640_000;

function equipment() {
  const own: Record<number, number[]> = {};
  return run(24, post => {
    for (let it = 1; it <= 8; it++) own[it] = [post(it, 1, P, 0), post(it, 1, P * 1.02, 0)];
    for (let k = 0; k < 8; k++) post(5, 1, P * (1.5 + k * 0.1), 0, 100_000); // item 5: a deep market of 10 copies
  }, (m, ls, post, pull) => {
    const h = Math.floor(m / 60), mm = m % 60;
    const cur = (it: number) => own[it]!.map(x => ls.find(l => l.id === x)).filter(Boolean) as L[];
    const rep = (it: number, f: (p: number) => number, which?: number) => {
      own[it] = cur(it).map((l, i) => { if (which != null && i !== which) return l.id; pull(l.id); return post(it, 1, Math.round(f(l.price)), m); });
    };
    if (mm === 30 && m > 0) {
      rep(1, p => p * 0.97); rep(2, p => p); rep(3, p => p * 0.97, h % 2); rep(4, p => p * 1.1); rep(5, p => p * 0.97);
      rep(7, p => (h % 2 ? p / 0.7 : p * 0.7));
      if (h === 2) rep(8, p => p * 0.97);
    }
    if (h % 3 === 0 && mm === 50) { for (const l of cur(6)) pull(l.id); own[6] = []; }
    if (h % 3 === 1 && mm === 10 && own[6]!.length === 0) own[6] = [post(6, 1, P, m), post(6, 1, P * 1.02, m)];
  });
}

function thinCommodity() {
  const own: Record<number, number[]> = {};
  return run(24, post => {
    own[11] = [0, 1, 2].map(() => post(11, 20, 1000, 0));
    own[12] = [0, 1, 2].map(() => post(12, 20, 1000, 0));
    own[13] = [post(13, 20, 1000, 0)]; post(13, 20, 1100, 0, 100_000); post(13, 20, 1200, 0, 100_000);
    own[14] = [0, 1, 2].map(() => post(14, 20, 1000, 0));
  }, (m, ls, post, pull) => {
    const h = Math.floor(m / 60), mm = m % 60;
    const live = (it: number) => own[it]!.filter(x => ls.some(l => l.id === x));
    if (mm === 30 && m > 0) {
      for (const x of live(11)) pull(x);
      own[11] = [0, 1, 2].map(() => post(11, 20, 1000, m));
      for (const x of live(12)) pull(x);
      own[12] = h % 2 ? [post(12, 30, 1000, m), post(12, 30, 1000, m)] : [0, 1, 2].map(() => post(12, 20, 1000, m));
      const f = ls.find(l => l.id === own[13]![0]);
      if (f) { pull(f.id); own[13] = [post(13, 20, Math.round(f.price * 0.97), m)]; }
    }
    if (h % 3 === 0 && mm === 50) { for (const x of live(14)) pull(x); own[14] = []; }
    if (h % 3 === 1 && mm === 10 && own[14]!.length === 0) own[14] = [0, 1, 2].map(() => post(14, 20, 1000, m));
  });
}

describe('repost churn with no buyer reads near 0', () => {
  const shapes = [
    { kind: 'auctions' as const, snaps: equipment(), items: {
      1: 'thin, both copies reposted 3% cheaper hourly', 2: 'thin, reposted at the same price', 3: 'thin, one copy reposted per hour',
      4: 'thin, reposted 10% dearer', 5: 'floor seller on a deep market of 10 copies, 3% cheaper hourly',
      6: 'thin, pulled at :50 and posted again at :10 every 3 hours', 7: 'thin, repriced 30% down and back',
      8: 'Timbermaw: 2 copies repriced once' } },
    { kind: 'commodities' as const, snaps: thinCommodity(), items: {
      11: 'thin, 3 stacks of 20 reposted hourly', 12: 'thin, 3 stacks of 20 reposted as 2 of 30 and back',
      13: 'thin, front stack reposted 3% cheaper', 14: 'thin, whole item pulled across a publish every 3 hours' } },
  ];
  for (const { kind, snaps, items } of shapes) {
    const db = load(snaps, kind);
    for (const [id, label] of Object.entries(items)) {
      it(`${kind}: ${label}`, () => {
        for (const h of [6, 12, 24]) {
          const d = demandByItem(db, 111, { now: snaps[h]!.at + 1 }).get(Number(id));
          // The floor seller's first hour is copies of unknown age, so it reads 2 sales once: 1.4 a day at 6 hours.
          expect(d?.lowPerDay ?? 0).toBeLessThanOrEqual(h === 6 ? 1.5 : 0.75);
          if (h === 24) expect(d?.soldUnits ?? 0).toBeLessThanOrEqual(2);
        }
      });
    }
  }
});
