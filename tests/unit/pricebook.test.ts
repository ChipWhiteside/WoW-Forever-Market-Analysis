import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { priceBook } from '../../src/analysis/prices.ts';
import { tempDir } from '../helpers.ts';

describe('the shared price book uses trusted prices', () => {
  it('a troll listing on a common item never becomes a price; a deep, steady market does', () => {
    const db = openDb(tempDir(), ':memory:');
    const t = Date.now() - 10 * 60_000;
    db.exec(`INSERT INTO houses (id, name, faction, cut, tracked, pinned) VALUES (111, 'Alliance Auction House', 'alliance', 0.05, 1, 1);
      INSERT INTO snapshots (id, house_id, kind, last_modified, published_at, fetched_at, rows, distinct_items, bytes) VALUES (1, 111, 'auctions', 'a', ${t}, ${t}, 1, 1, 1), (2, 111, 'commodities', 'b', ${t}, ${t}, 1, 1, 1);
      INSERT INTO items (id, name, quality, sell_price, status, fetched_at) VALUES (5956, 'Blacksmith Hammer', 'COMMON', 3, 200, 0), (2770, 'Copper Ore', 'COMMON', 5, 200, 0);
      INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder)
        VALUES (1, 111, 5956, ${t}, 900000, 1, 1, 1, 1, '[[900000,1]]'),
               (2, 111, 2770, ${t}, 95, 182, 300, 9000, 300, '[[95,182],[96,73],[97,323],[98,101],[99,66],[100,1112]]');`);
    const b = priceBook(db);
    expect(b.floor.has(5956)).toBe(false);
    expect(b.unproven?.get(5956)?.listed).toBe(900000);
    const ore = b.floor.get(2770)!;
    expect(ore.basis).toBe('market');
    expect(ore.floor).toBeGreaterThanOrEqual(95);
    expect(ore.floor).toBeLessThan(100);
  });
});
