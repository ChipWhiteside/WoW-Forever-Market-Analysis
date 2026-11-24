import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BlizzardClient } from '../../src/blizzard/client.ts';
import { ItemResponse } from '../../src/blizzard/contracts.ts';
import { resolveItems, applyItemSparse, getItem } from '../../src/catalog/items.ts';
import { loadGameDataFromDir, type SparseItem } from '../../src/datasets/gamedata.ts';
import { openDb } from '../../src/store/db.ts';
import { tempDir } from '../helpers.ts';

/** Real item responses recorded November 24 from us.api.blizzard.com (tests/fixtures/blizzard). */
const fixture = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/blizzard/${f}`, import.meta.url)), 'utf8');
const game = loadGameDataFromDir(fileURLToPath(new URL('../fixtures/wago', import.meta.url)), '1.60.1.71037');

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
    const items = new Map<number, SparseItem>([[999001, { id: 999001, name: 'Test Thing', bonding: 1, stackable: 1, vendorStack: 1, buyPrice: 40, sellPrice: 10, quality: 1 }]]);
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
});
