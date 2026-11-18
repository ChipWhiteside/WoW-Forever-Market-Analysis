/**
 * Seeds a demo database for UI smoke tests: realistic houses, items and plays, without Blizzard.
 * Usage: DATA_DIR=/some/dir npx tsx tests/e2e/seed.ts
 */
import { openDb } from '../../src/store/db.ts';
import { Engine } from '../../src/engine/engine.ts';
import { fakeBlizzard } from '../helpers.ts';

const dir = process.env.DATA_DIR!;
const db = openDb(dir);
const items: Record<number, { name: string; sell: number; q: string; cls: string }> = {
  2589: { name: 'Linen Cloth', sell: 13, q: 'COMMON', cls: 'Trade Goods' }, 2592: { name: 'Wool Cloth', sell: 33, q: 'COMMON', cls: 'Trade Goods' },
  2770: { name: 'Copper Ore', sell: 5, q: 'COMMON', cls: 'Trade Goods' }, 2840: { name: 'Copper Bar', sell: 10, q: 'COMMON', cls: 'Trade Goods' },
  6532: { name: 'Bright Baubles', sell: 62, q: 'COMMON', cls: 'Consumable' }, 4308: { name: 'Green Leather Bag', sell: 625, q: 'UNCOMMON', cls: 'Container' },
  2835: { name: 'Rough Stone', sell: 2, q: 'COMMON', cls: 'Trade Goods' }, 6289: { name: 'Raw Longjaw Mud Snapper', sell: 1, q: 'COMMON', cls: 'Consumable' },
};
let n = 1;
const C = (item: number, qty: number, price: number) => ({ id: n++, item: { id: item }, quantity: qty, unit_price: price, time_left: 'LONG' });
const lm = new Date(Date.now() - 6 * 60_000).toUTCString();
const routes: Record<string, () => any> = {
  '/data/wow/ruleset/2/auctions/': () => ({ body: { auctions: [{ id: 110, name: 'Alliance Auction House' }, { id: 111, name: 'Alliance Auction House' }, { id: 116, name: 'Blackwater Auction House' }] } }),
  '/data/wow/ruleset/2/auctions/110': () => ({ body: { id: 110, auctions: [{ id: n++, item: { id: 4308 }, buyout: 400, quantity: 1, time_left: 'LONG' }, { id: n++, item: { id: 4308 }, buyout: 9000, quantity: 1, time_left: 'LONG' }] }, lastModified: lm }),
  '/data/wow/ruleset/2/auctions/110/commodities': () => ({ body: { auctions: [C(2589, 34, 10), C(2589, 200, 22), C(2592, 60, 100), C(2592, 40, 125), C(2770, 300, 150), C(2840, 120, 167), C(6532, 12, 480), C(2835, 900, 4), C(6289, 40, 1)] }, lastModified: lm }),
  '/data/wow/ruleset/2/auctions/111': () => ({ body: { id: 111, auctions: [{ id: n++, item: { id: 4308 }, buyout: 8000, quantity: 1, time_left: 'LONG' }] }, lastModified: lm }),
  '/data/wow/ruleset/2/auctions/111/commodities': () => ({ body: { auctions: [C(2589, 100, 24), C(2770, 100, 84)] }, lastModified: lm }),
  '/data/wow/ruleset/2/auctions/116': () => ({ body: { id: 116, auctions: [{ id: n++, item: { id: 4308 }, buyout: 12000, quantity: 1, time_left: 'LONG' }] }, lastModified: lm }),
  '/data/wow/ruleset/2/auctions/116/commodities': () => ({ body: { auctions: [C(2592, 30, 160), C(2589, 50, 30), C(6532, 5, 700)] }, lastModified: lm }),
};
for (const [id, it] of Object.entries(items)) routes[`/data/wow/item/${id}`] = () => ({ body: { id: Number(id), name: it.name, quality: { type: it.q }, item_class: { id: 1, name: it.cls }, sell_price: it.sell, purchase_price: it.sell * 4 } });
const { client } = fakeBlizzard(routes);
const engine = new Engine(client, db, { dataDir: dir, webhookUrl: null, log: () => {} });
await engine.init();
db.prepare('UPDATE houses SET pinned = 1 WHERE id IN (110, 116)').run();
db.exec(`INSERT OR IGNORE INTO vendor_items (npc_id, npc_name, faction, zone, x, y, map_id, item_id, price, price_by_standing, units_per_purchase, limited) VALUES
  (2663, 'Old Man Heming', 'neutral', 'Stranglethorn Vale', 27.5, 77.1, 1434, 6532, 250, '{"4":250}', 1, 0),
  (1148, 'Nerrist', 'horde', 'Stranglethorn Vale', 32.7, 29.3, 1434, 6532, 250, '{"5":250}', 1, 0)`);
await engine.round();
db.close();
console.log('seeded', dir);
