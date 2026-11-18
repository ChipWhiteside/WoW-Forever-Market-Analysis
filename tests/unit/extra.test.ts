import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { buildServer } from '../../src/server/server.ts';
import { sourceBoard } from '../../src/drops/value.ts';
import type { PriceBook } from '../../src/analysis/prices.ts';
import { tempDir } from '../helpers.ts';

describe('world drops value per kill (O8)', () => {
  it('adds every drop times units per kill times its better of vendor and auction net', () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO loot (source_kind, source_id, source_name, zone, min_level, max_level, classification, item_id, chance, avg_count, kills, origin) VALUES
      ('npc', 1, 'Rabid Dire Wolf', 'Duskwood', 25, 26, 'normal', 100, 0.5, 0.5, 120, 'forever'),
      ('npc', 1, 'Rabid Dire Wolf', 'Duskwood', 25, 26, 'normal', 200, 0.1, 0.2, 120, 'forever'),
      ('npc', 2, 'Thin Sample', 'Duskwood', 25, 26, 'elite', 100, 1, 1, 7, 'forever')`);
    const book: PriceBook = { houseId: 110, faction: 'alliance', houseName: 'A', floor: new Map([[100, { floor: 200, units: 10, at: 0 }]]),
      sell: new Map([[100, 20], [200, 300]]), binding: new Map([[200, 'ON_ACQUIRE']]), names: new Map(), vendor: new Map() };
    const rows = sourceBoard(db, book, { minKills: 0 });
    const wolf = rows.find(r => r.sourceId === 1)!;
    // item 100: net floor(200*0.95)=190 - deposit floor(20*0.15)=3 = 187, x0.5 = 93.5; item 200 BoP vendor 300 x0.2 = 60
    expect(wolf.valuePerKill).toBe(154);
    expect(wolf.goldPerHour).toBe(154 * 60);
    expect(wolf.perHourBasis).toMatch(/estimated/);
    expect(rows.find(r => r.sourceId === 2)!.rough).toBe(true);
    expect(sourceBoard(db, book).find(r => r.sourceId === 2)).toBeUndefined(); // 7 kills, hidden by default
  });
});

describe('positions and farming API', () => {
  it('done opens a position and available gold falls; 20 ore in 10 minutes reads 120 an hour', async () => {
    const db = openDb(tempDir(), ':memory:');
    const app = buildServer({ db, engine: null, client: null, port: 0, dataDir: tempDir() });
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { starting_gold: 100000 } });
    await app.inject({ method: 'POST', url: '/api/positions', payload: { itemId: 6532, quantity: 20, unitCost: 250 } });
    const pos = (await app.inject({ url: '/api/positions' })).json();
    expect(pos.available).toBe(100000 - 5000);
    const { id } = (await app.inject({ method: 'POST', url: '/api/farming/start', payload: { activity: 'Copper in Elwynn' } })).json();
    db.prepare('UPDATE farm_sessions SET started_at = ? WHERE id = ?').run(Date.now() - 10 * 60_000, id);
    await app.inject({ method: 'POST', url: `/api/farming/${id}/end`, payload: { items: [{ itemId: 2770, count: 20 }] } });
    const f = (await app.inject({ url: '/api/farming' })).json();
    expect(Math.round(f[0].items[0].perHour)).toBe(120);
  });
});
