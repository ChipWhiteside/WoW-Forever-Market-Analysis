import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { alertCycle, isQuiet } from '../../src/alerts/discord.ts';
import { applyLifecycle } from '../../src/detectors/lifecycle.ts';
import type { Play } from '../../src/detectors/types.ts';
import { tempDir } from '../helpers.ts';

const noon = Date.parse('2026-11-18T19:00:00Z'); // noon in Denver
const P = (profit: number, key = 'vendor_dump:110:2589'): Play => ({ key, detector: 'vendor_dump', houseId: 110, itemId: 2589, profit, confidence: 'high', summary: 'x', detail: { buy: { kind: 'auction', price: 10, who: 'A', places: [] }, sell: { kind: 'any_vendor', price: 13, who: 'Any vendor', places: [] }, perItem: 3, salesPerDay: null, available: 1, realisticUnits: 1 }, dataAt: noon - 60_000 });

describe('alerts', () => {
  it('one message for new plays, nothing for repeats, again only after 25 percent growth', async () => {
    const db = openDb(tempDir(), ':memory:');
    db.prepare(`INSERT INTO settings (key, value) VALUES ('play_alerts', '1')`).run();
    const sent: string[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    const pinned = new Set([110]);
    applyLifecycle(db, [P(5000)], { detectors: ['vendor_dump'], houses: [110] }, noon);
    expect((await alertCycle(db, 'https://discord/x', [P(5000)], pinned, { now: noon, fetchFn })).sent).toBe(1);
    expect((await alertCycle(db, 'https://discord/x', [P(5500)], pinned, { now: noon, fetchFn })).sent).toBe(0);
    expect((await alertCycle(db, 'https://discord/x', [P(7000)], pinned, { now: noon, fetchFn })).sent).toBe(1);
    expect(sent).toHaveLength(2);
  });
  it('sends nothing when nothing clears the bar, and never for unpinned houses', async () => {
    const db = openDb(tempDir(), ':memory:');
    db.prepare(`INSERT INTO settings (key, value) VALUES ('play_alerts', '1')`).run();
    const r = await alertCycle(db, 'https://discord/x', [P(100), { ...P(99999), houseId: 111, key: 'k2' }], new Set([110]), { now: noon });
    expect(r).toEqual({ sent: 0, skipped: 'nothing new' });
  });
  it('old play alerts are off by default (Chip, November 26) and come back with play_alerts', async () => {
    const db = openDb(tempDir(), ':memory:');
    const sent: string[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    applyLifecycle(db, [P(5000)], { detectors: ['vendor_dump'], houses: [110] }, noon);
    expect(await alertCycle(db, 'https://discord/x', [P(5000)], new Set([110]), { now: noon, fetchFn })).toEqual({ sent: 0, skipped: 'play alerts off' });
    db.prepare(`INSERT INTO settings (key, value) VALUES ('play_alerts', '1')`).run();
    expect((await alertCycle(db, 'https://discord/x', [P(5000)], new Set([110]), { now: noon, fetchFn })).sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it('respects quiet hours in his time zone', () => {
    const s = { quietStart: 23, quietEnd: 7, timeZone: 'America/Denver' };
    expect(isQuiet(Date.parse('2026-11-19T08:00:00Z'), s)).toBe(true);  // 1am Denver
    expect(isQuiet(noon, s)).toBe(false);
  });
});
