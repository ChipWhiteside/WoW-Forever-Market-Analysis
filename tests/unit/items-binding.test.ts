import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkItemsAfterRefresh } from '../../src/datasets/recipes.ts';
import { BlizzardClient } from '../../src/blizzard/client.ts';
import { ItemResponse } from '../../src/blizzard/contracts.ts';
import { resolveItems, applyItemSparse, getItem, itemTradeable, tradeBlock } from '../../src/catalog/items.ts';
import { loadGameDataFromDir, type SparseItem } from '../../src/datasets/gamedata.ts';
import { openDb } from '../../src/store/db.ts';
import { tempDir } from '../helpers.ts';

/** Real item responses recorded November 24 from us.api.blizzard.com (tests/fixtures/blizzard). */
const fixture = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/blizzard/${f}`, import.meta.url)), 'utf8');
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/wago', import.meta.url));
const game = loadGameDataFromDir(FIXTURE_DIR, '1.60.1.71037');

/** A fake Blizzard that answers by item id and namespace, and records what it was asked. */
function fake(routes: Record<string, { status: number; body: string; headers?: Record<string, string> } | Array<{ status: number; body: string; headers?: Record<string, string> }>>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth.battle.net') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }));
    const key = `${url.pathname.split('/').pop()}:${url.searchParams.get('namespace')}`;
    calls.push(key);
    let r = routes[key];
    if (Array.isArray(r)) r = r.length > 1 ? r.shift()! : r[0]!;
    if (!r) return new Response('{"code":404}', { status: 404 });
    return new Response(r.body, { status: r.status, headers: r.headers ?? {} });
  }) as typeof fetch;
  const client = new BlizzardClient('id', 'secret', 'us', fetchFn);
  client.minGapMs = 0;
  return { client, calls };
}
const ok = (f: string) => ({ status: 200, body: fixture(f) });

describe('item binding from a real Blizzard response (B22)', () => {
  it('the contract reads preview_item.binding; there is no top level binding', () => {
    const b = ItemResponse.parse(JSON.parse(fixture('item-5060-forever.json')));
    expect(b.binding).toBeUndefined();
    expect(b.preview_item?.binding?.type).toBe('ON_ACQUIRE');
    expect(ItemResponse.parse(JSON.parse(fixture('item-2589-forever.json'))).preview_item?.binding).toBeUndefined();
  });

  it('resolveItems stores ON_ACQUIRE for Thieves\' Tools, ON_EQUIP for Green Linen Bracers, none for Linen Cloth', async () => {
    const db = openDb(tempDir(), ':memory:');
    const { client } = fake({ '5060:static-forever-us': ok('item-5060-forever.json'), '4308:static-forever-us': ok('item-4308-forever.json'), '2589:static-forever-us': ok('item-2589-forever.json') });
    const r = await resolveItems(client, db, [5060, 4308, 2589], { game });
    expect(r).toMatchObject({ fetched: 3, bindingFound: 2, bySource: { forever: 3, classic1x: 0, wago: 0, none: 0 } });
    expect(getItem(db, 5060)).toMatchObject({ binding: 'ON_ACQUIRE', data_source: 'forever' });
    expect(getItem(db, 4308)).toMatchObject({ binding: 'ON_EQUIP' });
    // Linen Cloth: no binding, and the game table adds bonding 0, stacks of 20, sold one at a time.
    expect(getItem(db, 2589)).toMatchObject({ binding: null, bonding: 0, stack_size: 20, vendor_stack: 1, sell_price: 13 });
  });
});

describe('the Classic item data fallback (B25)', () => {
  it('a Forever 404 is asked of static-classic1x and stored as classic1x: Brawler Gloves', async () => {
    const db = openDb(tempDir(), ':memory:');
    const { client, calls } = fake({ '720:static-forever-us': { status: 404, body: fixture('item-720-forever.json') }, '720:static-classic1x-us': ok('item-720-classic1x.json') });
    const r = await resolveItems(client, db, [720], { game });
    expect(calls).toEqual(['720:static-forever-us', '720:static-classic1x-us']);
    expect(r.bySource).toEqual({ forever: 0, classic1x: 1, wago: 0, none: 0 });
    expect(getItem(db, 720)).toMatchObject({ name: 'Brawler Gloves', status: 200, data_source: 'classic1x', binding: 'ON_EQUIP', sell_price: 1070 });
  });

  it('known to neither Blizzard source: the game table row fills the name and binding, data_source wago', async () => {
    const db = openDb(tempDir(), ':memory:');
    const { client } = fake({});
    const items = new Map<number, SparseItem>([[999001, { id: 999001, name: 'Test Thing', bonding: 1, stackable: 1, vendorStack: 1, buyPrice: 40, sellPrice: 10, quality: 1, requiredSkill: 0, requiredSkillRank: 0, minFactionId: 0, minReputation: 0 }]]);
    await resolveItems(client, db, [999001, 999002], { game: { items } });
    expect(getItem(db, 999001)).toMatchObject({ name: 'Test Thing', name_source: 'wago', data_source: 'wago', status: 404, binding: 'ON_ACQUIRE', bonding: 1, quality: 'COMMON' });
    expect(getItem(db, 999002)).toMatchObject({ name: null, status: 404, data_source: 'none' });
  });

  it('a 404 stored before the fallback existed is asked again now; a row fetched before binding was read is refetched once', async () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO items (id, status, fetched_at) VALUES (720, 404, ${Date.now()});
      INSERT INTO items (id, name, status, fetched_at) VALUES (5060, 'Thieves'' Tools', 200, ${Date.now()})`);
    const { client } = fake({ '720:static-classic1x-us': ok('item-720-classic1x.json'), '5060:static-forever-us': ok('item-5060-forever.json') });
    const r = await resolveItems(client, db, [720, 5060], { maxAgeMs: Infinity });
    expect(r.bySource).toMatchObject({ classic1x: 1, forever: 1 });
    expect(getItem(db, 5060)?.binding).toBe('ON_ACQUIRE');
    const again = await resolveItems(client, db, [720, 5060], { maxAgeMs: Infinity });
    expect(again.fetched + again.notFound).toBe(0);
  });
});

describe('rate limits (B26)', () => {
  it('a 429 waits for Retry-After, is counted, and the request then succeeds', async () => {
    const db = openDb(tempDir(), ':memory:');
    const { client } = fake({ '2589:static-forever-us': [{ status: 429, body: '', headers: { 'retry-after': '1' } }, ok('item-2589-forever.json')] });
    const t = Date.now();
    const r = await resolveItems(client, db, [2589]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(950);
    expect(client.throttled).toBe(1);
    expect(r.fetched).toBe(1);
  });
});

describe('binding against ItemSparse.Bonding (B23)', () => {
  it('counts agreement only where both sources exist, and fills bonding on every known row', () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO items (id, binding, status, fetched_at, data_source) VALUES
      (2589, NULL, 200, 0, 'forever'), (3371, 'ON_ACQUIRE', 200, 0, 'forever'), (720, 'ON_EQUIP', 200, 0, 'classic1x'), (999, NULL, 404, 0, 'none')`);
    const r = applyItemSparse(db, game);
    expect(r.compared).toBe(2); // 720 and 999 are not in the game table
    expect(r.disagree).toEqual([{ id: 3371, blizzard: 'ON_ACQUIRE', bonding: 0 }]);
    expect(getItem(db, 3371)).toMatchObject({ bonding: 0, stack_size: 20, vendor_stack: 5 });
  });

  // Round 2 fix 2. The live Forever API (recorded November 25) binds Instant Poison on pickup with sell price 0,
  // while ItemSparse of build 1.60.1.71037 still says Bonding 0 and SellPrice 5: a server hotfix.
  it('a hotfixed poison shows as both a binding and a sell price disagreement once the API side is refreshed', async () => {
    const db = openDb(tempDir(), ':memory:');
    const { client } = fake({ '6947:static-forever-us': ok('item-6947-forever.json'), '2589:static-forever-us': ok('item-2589-forever.json') });
    await resolveItems(client, db, [6947, 2589], { game });
    expect(getItem(db, 6947)).toMatchObject({ name: 'Instant Poison', binding: 'ON_ACQUIRE', sell_price: 0, bonding: 0 });
    expect(game.items.get(6947)).toMatchObject({ bonding: 0, sellPrice: 5 });
    const r = applyItemSparse(db, game);
    expect(r.disagree).toEqual([{ id: 6947, blizzard: 'ON_ACQUIRE', bonding: 0 }]);
    expect(r).toMatchObject({ sellCompared: 2, sellDisagree: [{ id: 6947, blizzard: 0, sparse: 5 }] });
  });

  it('the daily item check runs on cached game tables, logs both counts and writes them into the gamedata note', async () => {
    const dir = tempDir();
    const wago = join(dir, 'datasets', 'wago', '1.60.1.71037');
    mkdirSync(wago, { recursive: true });
    for (const f of readdirSync(FIXTURE_DIR)) copyFileSync(join(FIXTURE_DIR, f), join(wago, f));
    const db = openDb(dir, ':memory:');
    db.exec(`INSERT INTO datasets (name, version, fetched_at, records, note) VALUES ('gamedata', '1.60.1.71037', 0, 0, 'old')`);
    const { client } = fake({ '6947:static-forever-us': ok('item-6947-forever.json') });
    await resolveItems(client, db, [6947], { game });
    const line = checkItemsAfterRefresh(db, dir);
    expect(line).toBe('binding disagrees with ItemSparse on 1 of 1 (6947); sell price disagrees on 1 of 1 (6947)');
    expect((db.prepare(`SELECT note FROM datasets WHERE name = 'gamedata'`).get() as { note: string }).note).toBe(`wago wowf tables; ${line}`);
  });
});

// Round 3 D2: one tradeable verdict. Rows as the live catalog held them on November 25 (wowf.db copy), listings as
// recorded on tracked houses: Blinding Powder 5530 and Encrypted Twilight Text 20404 listed that hour, Piccolo of the
// Flaming Fire 13379 too; Instant Poison 6947 last listed November 24, more than 24 hours before.
describe('itemTradeable: market evidence, then the Forever API, then ItemSparse (round 3 D2)', () => {
  const NOW = 1795631176000;
  const setup = () => {
    const db = openDb(tempDir(), ':memory:');
    db.exec(`INSERT INTO houses (id, name, faction, cut, tracked) VALUES (111, 'A', 'alliance', 0.05, 1), (999, 'Old', 'alliance', 0.05, 0);
      INSERT INTO items (id, name, binding, bonding, status, fetched_at, data_source) VALUES
        (5530, 'Blinding Powder', NULL, 1, 200, 0, 'forever'),
        (20404, 'Encrypted Twilight Text', NULL, 4, 200, 0, 'forever'),
        (13379, 'Piccolo of the Flaming Fire', 'ON_ACQUIRE', NULL, 200, 0, 'classic1x'),
        (6947, 'Instant Poison', 'ON_ACQUIRE', 1, 200, 0, 'forever'),
        (1, 'Unlisted, unbound in the API, bound in ItemSparse', NULL, 1, 200, 0, 'forever'),
        (2, 'Unlisted, Classic says pickup', 'ON_ACQUIRE', 0, 200, 0, 'classic1x'),
        (3, 'Unlisted, only ItemSparse', NULL, 1, 404, 0, 'wago');
      INSERT INTO item_stats (snapshot_id, house_id, item_id, published_at, floor, units_at_floor, units_within5, total_units, listings, ladder) VALUES
        (1, 111, 5530, ${NOW}, 100, 1, 1, 6470, 40, '[]'), (1, 111, 20404, ${NOW}, 100, 1, 1, 45, 45, '[]'), (1, 111, 13379, ${NOW}, 100, 1, 1, 30, 30, '[]'),
        (2, 111, 6947, 1795501512000, 10, 1, 1, 5, 5, '[]'), (3, 999, 1, ${NOW}, 10, 1, 1, 5, 5, '[]');`);
    return db;
  };
  it('listed in the last 24 hours wins; poisons stay blocked; the API beats ItemSparse; Classic binding alone never blocks', () => {
    const t = itemTradeable(setup(), NOW);
    expect(t.get(5530)).toMatchObject({ tradeable: true, by: 'listed' });
    expect(t.get(20404)).toMatchObject({ tradeable: true, by: 'listed' });
    expect(t.get(13379)).toMatchObject({ tradeable: true, by: 'listed' });
    expect(t.get(6947)).toMatchObject({ tradeable: false, by: 'api' });
    expect(t.get(1)).toMatchObject({ tradeable: true, by: 'api' }); // its listing is on an untracked house
    expect(t.get(2)).toMatchObject({ tradeable: true });
    expect(t.get(3)).toMatchObject({ tradeable: false, by: 'itemsparse' });
  });
  it('the flip gate reads the same verdict', () => {
    itemTradeable(setup(), NOW);
    expect(tradeBlock({ id: 5530, binding: null, bonding: 1 })).toBeNull();
    expect(tradeBlock({ id: 6947, binding: 'ON_ACQUIRE', bonding: 1 })).toMatch(/binds on pickup/);
  });
});
