import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { Engine } from '../../src/engine/engine.ts';
import { buildServer } from '../../src/server/server.ts';
import { fakeBlizzard, tempDir } from '../helpers.ts';

/** End to end on a fake Blizzard: index, two houses, item data, one publish with a vendor dump. */
describe('engine end to end', () => {
  it('polls, catalogs, detects, alerts and serves', async () => {
    const dir = tempDir();
    const lm = new Date(Date.now() - 5 * 60_000).toUTCString();
    const { client } = fakeBlizzard({
      '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [
        { id: 110, name: 'Alliance Auction House' }, { id: 113, name: 'Horde Auction House' }, { id: 116, name: 'Blackwater Auction House' }] } }),
      '/data/wow/ruleset/2/auctions/110': () => ({ body: { id: 110, auctions: [{ id: 1, item: { id: 4308 }, buyout: 698, quantity: 1, time_left: 'LONG' }] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/110/commodities': () => ({ body: { auctions: [
        { id: 2, item: { id: 2589 }, quantity: 200, unit_price: 10, time_left: 'LONG' },
        { id: 3, item: { id: 2589 }, quantity: 20, unit_price: 22, time_left: 'LONG' }] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/116': () => ({ body: { id: 116, auctions: [] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/116/commodities': () => ({ body: { auctions: [{ id: 9, item: { id: 2589 }, quantity: 5, unit_price: 30, time_left: 'LONG' }] }, lastModified: lm }),
      '/data/wow/item/2589': () => ({ body: { id: 2589, name: 'Linen Cloth', quality: { type: 'COMMON' }, sell_price: 13, purchase_price: 55, media: { id: 2589 } } }),
      '/data/wow/item/4308': () => ({ body: { id: 4308, name: 'Green Leather Bracers', sell_price: 100, binding: { type: 'ON_EQUIP' } } }),
      '/data/wow/media/item/2589': () => ({ body: { assets: [{ key: 'icon', value: 'https://render.worldofwarcraft.com/us/icons/56/inv_fabric_linen_01.jpg' }] } }),
    });
    const db = openDb(dir, ':memory:');
    const sent: string[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    const engine = new Engine(client, db, { dataDir: dir, webhookUrl: 'https://discord.example/hook', log: () => {}, fetchFn });
    await engine.init();
    db.prepare(`UPDATE houses SET pinned = 1 WHERE id IN (110, 116)`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('profit_bar', '100'), ('quiet_start', '0'), ('quiet_end', '0')`).run();

    const r = await engine.round();
    expect(r.events.length).toBe(4); // 116 auctions is empty, still a publish, and flagged as a suspected bug
    expect(r.events.flatMap(e => e.suspect)).toEqual(["house 116 auctions: zero listings"]);
    const dump = r.plays.find(p => p.detector === 'vendor_dump')!;
    expect(dump.profit).toBe((13 - 10) * 200);
    expect(r.plays.some(p => p.detector === 'cross_house')).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatch(/Vendor dump/);

    // Same publish again: 304s, no new events, no message.
    const r2 = await engine.round();
    expect(r2.events.length).toBe(0);
    expect(sent.length).toBe(1);

    const app = buildServer({ db, engine, client, port: 0, dataDir: dir });
    const plays = (await app.inject({ url: '/api/plays' })).json();
    expect(plays[0].item_name).toBe('Linen Cloth');
    expect(plays[0].icon_url).toMatch(/inv_fabric_linen/);
    const item = (await app.inject({ url: '/api/items/2589' })).json();
    expect(item.houses.length).toBe(2);
    const health = (await app.inject({ url: '/api/health' })).json();
    expect(health.suspects).toEqual([]);
    const houses = (await app.inject({ url: '/api/houses' })).json();
    expect(houses.find((h: { id: number }) => h.id === 113)).toBeUndefined(); // Horde never tracked
  });
});

describe('dev channel health reports', () => {
  it('a suspected bug posts once to dev, never to plays, and does not flap', async () => {
    const dir = tempDir();
    const { client } = fakeBlizzard({
      '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 110, name: 'Alliance Auction House' }] } }),
      '/data/wow/ruleset/2/auctions/110': () => ({ body: { id: 110 }, lastModified: new Date(Date.now() - 60_000).toUTCString() }),
    });
    const db = openDb(dir, ':memory:');
    const posts: string[] = [];
    const fetchFn = (async (u: string, init: RequestInit) => { posts.push(`${u} ${String(init.body)}`); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    const engine = new Engine(client, db, { dataDir: dir, webhookUrl: 'https://plays', devWebhookUrl: 'https://dev', log: () => {}, fetchFn });
    await engine.init();
    await engine.round(); // empty house 110 auctions: suspected bug
    await engine.round(); // 304, nothing new
    await engine.round();
    expect(posts.filter(p => p.startsWith('https://plays'))).toHaveLength(0);
    const dev = posts.filter(p => p.startsWith('https://dev'));
    expect(dev).toHaveLength(1);
    expect(dev[0]).toMatch(/Suspected bug/);
  });
});
