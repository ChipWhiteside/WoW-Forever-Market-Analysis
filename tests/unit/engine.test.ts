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
    db.prepare(`INSERT INTO settings (key, value) VALUES ('profit_bar', '100'), ('quiet_start', '0'), ('quiet_end', '0'), ('min_profit_each', '0'), ('play_alerts', '1')`).run();

    const r = await engine.round();
    expect(r.events.length).toBe(4); // 116 auctions is empty, still a publish, and flagged as a suspected bug
    expect(r.events.flatMap(e => e.suspect)).toEqual(["house 116 auctions: zero listings"]);
    const dump = r.plays.find(p => p.detector === 'vendor_dump')!;
    expect(dump.profit).toBe((13 - 10) * 200);
    // No sales history yet, so no resale play is trusted on the first snapshot. Vendor dumps need none.
    expect(r.plays.some(p => p.detector === 'cross_house')).toBe(false);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatch(/Auction house to vendor/);

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

describe('restart', () => {
  it('a fresh engine rebuilds plays from the last stored snapshot without waiting for a publish', async () => {
    const dir = tempDir();
    const lm = new Date(Date.now() - 5 * 60_000).toUTCString();
    const { client } = fakeBlizzard({
      '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 110, name: 'Alliance Auction House' }] } }),
      '/data/wow/ruleset/2/auctions/110': () => ({ body: { id: 110, auctions: [] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/110/commodities': () => ({ body: { auctions: [{ id: 2, item: { id: 2589 }, quantity: 50, unit_price: 10, time_left: 'LONG' }] }, lastModified: lm }),
      '/data/wow/item/2589': () => ({ body: { id: 2589, name: 'Linen Cloth', sell_price: 13 } }),
    });
    const db = openDb(dir, 'restart.db');
    db.exec(`INSERT INTO settings (key, value) VALUES ('min_profit_each', '0')`);
    const first = new Engine(client, db, { dataDir: dir, webhookUrl: null, log: () => {} });
    await first.init();
    await first.round();
    db.exec(`DELETE FROM plays`); // what an update to a new play format looks like: nothing usable left
    const second = new Engine(client, db, { dataDir: dir, webhookUrl: null, log: () => {} });
    await second.init();
    const r = await second.detect();
    expect(r.plays.find(p => p.detector === 'vendor_dump')?.detail.perItem).toBe(3);
  });
});

describe('only your houses', () => {
  it('once a house is picked, plays on unpicked houses stop and old ones close', async () => {
    const dir = tempDir();
    const lm = new Date(Date.now() - 5 * 60_000).toUTCString();
    const C = (id: number) => ({ body: { auctions: [{ id, item: { id: 2589 }, quantity: 50, unit_price: 10, time_left: 'LONG' }] }, lastModified: lm });
    const { client } = fakeBlizzard({
      '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 111, name: 'Alliance Auction House' }, { id: 116, name: 'Blackwater Auction House' }] } }),
      '/data/wow/ruleset/2/auctions/111': () => ({ body: { id: 111, auctions: [] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/116': () => ({ body: { id: 116, auctions: [] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/111/commodities': () => C(1),
      '/data/wow/ruleset/2/auctions/116/commodities': () => C(2),
      '/data/wow/item/2589': () => ({ body: { id: 2589, name: 'Linen Cloth', sell_price: 13 } }),
    });
    const db = openDb(dir, ':memory:');
    db.exec(`INSERT INTO settings (key, value) VALUES ('min_profit_each', '0')`);
    const engine = new Engine(client, db, { dataDir: dir, webhookUrl: null, log: () => {} });
    await engine.init();
    await engine.round();
    expect(new Set((db.prepare(`SELECT house_id FROM plays WHERE state != 'gone'`).all() as Array<{ house_id: number }>).map(r => r.house_id))).toEqual(new Set([111, 116]));
    db.prepare('UPDATE houses SET pinned = 1 WHERE id = 111').run();
    await engine.detect();
    expect((db.prepare(`SELECT house_id FROM plays WHERE state != 'gone'`).all() as Array<{ house_id: number }>).map(r => r.house_id)).toEqual([111]);
  });
});

describe('minimum profit per item', () => {
  it('a 3 copper play never shows; raising the bar to 1 copper lets it through', async () => {
    const dir = tempDir();
    const lm = new Date(Date.now() - 5 * 60_000).toUTCString();
    const { client } = fakeBlizzard({
      '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 111, name: 'Alliance Auction House' }] } }),
      '/data/wow/ruleset/2/auctions/111': () => ({ body: { id: 111, auctions: [] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/111/commodities': () => ({ body: { auctions: [
        { id: 1, item: { id: 2589 }, quantity: 50, unit_price: 10, time_left: 'LONG' },
        { id: 2, item: { id: 2592 }, quantity: 5, unit_price: 50, time_left: 'LONG' }] }, lastModified: lm }),
      '/data/wow/item/2589': () => ({ body: { id: 2589, name: 'Linen Cloth', sell_price: 13 } }),
      '/data/wow/item/2592': () => ({ body: { id: 2592, name: 'Wool Cloth', sell_price: 200 } }),
    });
    const db = openDb(dir, ':memory:');
    const engine = new Engine(client, db, { dataDir: dir, webhookUrl: null, log: () => {} });
    await engine.init();
    const r = await engine.round();
    expect(r.plays.map(p => p.itemId)).toEqual([2592]); // 1s 50c each passes, 3c each does not
    db.exec(`INSERT INTO settings (key, value) VALUES ('min_profit_each', '1')`);
    expect((await engine.detect()).plays.map(p => p.itemId).sort()).toEqual([2589, 2592]);
  });
});

describe('closest calls', () => {
  it('an empty board explains itself: candidates under the minimum or without evidence are listed with the reason', async () => {
    const dir = tempDir();
    const lm = new Date(Date.now() - 5 * 60_000).toUTCString();
    const { client } = fakeBlizzard({
      '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 111, name: 'Alliance Auction House' }] } }),
      '/data/wow/ruleset/2/auctions/111': () => ({ body: { id: 111, auctions: [] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/111/commodities': () => ({ body: { auctions: [
        { id: 1, item: { id: 2589 }, quantity: 50, unit_price: 10, time_left: 'LONG' },
        { id: 2, item: { id: 3857 }, quantity: 20, unit_price: 800, time_left: 'LONG' }] }, lastModified: lm }),
      '/data/wow/item/2589': () => ({ body: { id: 2589, name: 'Linen Cloth', sell_price: 13 } }),
      '/data/wow/item/3857': () => ({ body: { id: 3857, name: 'Coal', sell_price: 125 } }),
    });
    const db = openDb(dir, ':memory:');
    db.exec(`INSERT INTO vendor_items (npc_id, npc_name, faction, zone, x, y, map_id, item_id, price, price_by_standing, units_per_purchase, limited, standing_required)
      VALUES (1, 'Smith', 'alliance', 'Stormwind City', 50, 50, 1453, 3857, 500, '{"5":500}', 1, 0, '5')`);
    const engine = new Engine(client, db, { dataDir: dir, webhookUrl: null, log: () => {} });
    await engine.init();
    const r = await engine.round();
    expect(r.plays).toHaveLength(0);
    const cc = JSON.parse((db.prepare(`SELECT value FROM kv WHERE key = 'closest_calls'`).get() as { value: string }).value);
    const coal = cc.calls.find((c: { itemId: number }) => c.itemId === 3857);
    expect(coal.reason).toMatch(/no sales seen yet/);
    expect(cc.calls.find((c: { itemId: number }) => c.itemId === 2589).reason).toMatch(/minimum/);
  });
});

describe('within reach', () => {
  it('units are capped at what gold on hand can buy; what cannot be afforded once is held back', async () => {
    const dir = tempDir();
    const lm = new Date(Date.now() - 5 * 60_000).toUTCString();
    const { client } = fakeBlizzard({
      '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 111, name: 'Alliance Auction House' }] } }),
      '/data/wow/ruleset/2/auctions/111': () => ({ body: { id: 111, auctions: [] }, lastModified: lm }),
      '/data/wow/ruleset/2/auctions/111/commodities': () => ({ body: { auctions: [
        { id: 1, item: { id: 2592 }, quantity: 50, unit_price: 5000, time_left: 'LONG' },
        { id: 2, item: { id: 9999 }, quantity: 1, unit_price: 200000, time_left: 'LONG' }] }, lastModified: lm }),
      '/data/wow/item/2592': () => ({ body: { id: 2592, name: 'Pricey Thing', sell_price: 6000 } }),
      '/data/wow/item/9999': () => ({ body: { id: 9999, name: 'Gold Bar Thing', sell_price: 300000 } }),
    });
    const db = openDb(dir, ':memory:');
    db.exec(`INSERT INTO settings (key, value) VALUES ('gold_on_hand', '12')`);
    const engine = new Engine(client, db, { dataDir: dir, webhookUrl: null, log: () => {} });
    await engine.init();
    const r = await engine.round();
    const p = r.plays.find(x => x.itemId === 2592)!;
    expect(p.detail.realisticUnits).toBe(24); // 12g / 50s each
    expect(p.detail.costToDo).toBe(24 * 5000);
    expect(r.plays.find(x => x.itemId === 9999)).toBeUndefined(); // 20g each, more than 12g
  });
});
