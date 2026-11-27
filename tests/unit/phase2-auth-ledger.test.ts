import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { openDb, type DB } from '../../src/store/db.ts';
import { buildServer } from '../../src/server/server.ts';
import { makeAuth, readCookie, COOKIE, SESSION_DAYS } from '../../src/server/auth.ts';
import { expectedFor, ledgerTotals, type ActionRow } from '../../src/server/ledger.ts';
import { tempDir } from '../helpers.ts';

const PW = 'hunter2';
const SECRET = 'test-secret';
const app = (db: DB = openDb(tempDir(), ':memory:'), password: string | null = PW) => buildServer({ db, engine: null, client: null, port: 0, dataDir: tempDir(), auth: { password, secret: SECRET } });
const cookieOf = (setCookie: unknown) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

/** A flip with three amounts: small 2, best 5, most 10. Money in copper. */
function addFlip(db: DB, key = 'craft_auction:1:100:7') {
  const detail = { key, name: 'Heavy Linen Bandage', itemId: 100, perItem: 300,
    best: { label: 'best', units: 5, cost: 1000, expectedProfit: 1500 },
    options: [{ label: 'small', units: 2, cost: 400, expectedProfit: 600 }, { label: 'best', units: 5, cost: 1000, expectedProfit: 1500 }, { label: 'most', units: 10, cost: 2000, expectedProfit: 2200 }] };
  db.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at) VALUES (?, 'craft', 'craft_auction', 1, 100, 'live', 1500, 'low', ?, 1, 1, 1)`).run(key, JSON.stringify(detail));
  return key;
}

describe('login cookie', () => {
  const auth = makeAuth({ password: PW, secret: SECRET });
  it('a good token names its user; tampered, wrong secret, expired and junk tokens name nobody', () => {
    const now = 1_700_000_000_000;
    const t = auth.sign('Chip', now);
    expect(auth.verify(t, now)).toBe('Chip');
    expect(auth.verify(t, now + SESSION_DAYS * 86_400_000 - 1)).toBe('Chip');
    expect(auth.verify(t, now + SESSION_DAYS * 86_400_000)).toBeNull(); // expired at 90 days
    const [u, exp, sig] = t.split('.') as [string, string, string];
    expect(auth.verify(`${Buffer.from('Mallory').toString('base64url')}.${exp}.${sig}`, now)).toBeNull(); // name swapped
    expect(auth.verify(`${u}.${Number(exp) + 86_400_000}.${sig}`, now)).toBeNull(); // life extended
    expect(auth.verify(`${u}.${exp}.${sig.slice(0, -2)}AA`, now)).toBeNull();
    expect(makeAuth({ password: PW, secret: 'other' }).verify(t, now)).toBeNull();
    // A token re-signed by hand with the right secret is accepted: the HMAC is the whole check.
    const body = `${u}.${exp}`;
    expect(auth.verify(`${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`, now)).toBe('Chip');
    for (const junk of ['', 'a.b', 'a.b.c.d', 'x.y.z', null, undefined]) expect(auth.verify(junk, now)).toBeNull();
  });
  it('reads the cookie from a header with others around it', () => {
    expect(readCookie(`a=1; ${COOKIE}=abc.123.x%3D; b=2`, COOKIE)).toBe('abc.123.x=');
    expect(readCookie('a=1', COOKIE)).toBeNull();
    expect(readCookie(undefined, COOKIE)).toBeNull();
  });
  it('POST /api/login: right password sets an HttpOnly SameSite=Lax 90 day cookie, Secure only over https', async () => {
    const a = app();
    const r = await a.inject({ method: 'POST', url: '/api/login', payload: { username: '  Chip  ', password: PW } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, username: 'Chip' });
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(new RegExp(`^${COOKIE}=`));
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain(`Max-Age=${90 * 86400}`);
    expect(sc).not.toContain('Secure');
    const s = await a.inject({ method: 'POST', url: '/api/login', headers: { 'x-forwarded-proto': 'https' }, payload: { username: 'Chip', password: PW } });
    expect(String(s.headers['set-cookie'])).toContain('; Secure');
    const me = await a.inject({ url: '/api/me', headers: { cookie: cookieOf(r.headers['set-cookie']) } });
    expect(me.json()).toEqual({ authRequired: true, username: 'Chip' });
  });
  it('wrong password and empty name are refused with no cookie', async () => {
    const a = app();
    const bad = await a.inject({ method: 'POST', url: '/api/login', payload: { username: 'Chip', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
    const noName = await a.inject({ method: 'POST', url: '/api/login', payload: { username: '   ', password: PW } });
    expect(noName.statusCode).toBe(400);
    expect((await a.inject({ url: '/api/me' })).json()).toEqual({ authRequired: true, username: null });
  });
  it('logout clears the cookie', async () => {
    const r = await app().inject({ method: 'POST', url: '/api/logout', headers: { cookie: `${COOKIE}=${makeAuth({ password: PW, secret: SECRET }).sign('Chip')}` } });
    expect(String(r.headers['set-cookie'])).toMatch(new RegExp(`^${COOKIE}=; .*Max-Age=0`));
  });
});

describe('auth gate', () => {
  it('with SITE_PASSWORD set, every /api route but login and me answers 401 without a good cookie', async () => {
    const a = app();
    const auth = makeAuth({ password: PW, secret: SECRET });
    for (const [method, url] of [['GET', '/api/flips'], ['GET', '/api/settings'], ['PUT', '/api/settings'], ['GET', '/api/ledger'], ['POST', '/api/flips/x/did'], ['POST', '/api/flips/refresh'], ['GET', '/api/overview'], ['POST', '/api/logout'], ['GET', '/api/flips?gone=1']] as const) {
      expect((await a.inject({ method, url, payload: method === 'GET' ? undefined : {} })).statusCode, `${method} ${url}`).toBe(401);
      expect((await a.inject({ method, url, headers: { cookie: `${COOKIE}=${auth.sign('Chip', Date.now() - 91 * 86_400_000)}` }, payload: method === 'GET' ? undefined : {} })).statusCode, `expired ${url}`).toBe(401);
    }
    const ok = await a.inject({ url: '/api/flips', headers: { cookie: `${COOKIE}=${auth.sign('Chip')}` } });
    expect(ok.statusCode).toBe(200);
    expect((await a.inject({ url: '/api/me' })).statusCode).toBe(200);
  });
  it('with no password, routes are open, login takes any password and names the user', async () => {
    const a = app(undefined, null);
    expect((await a.inject({ url: '/api/flips' })).statusCode).toBe(200);
    expect((await a.inject({ url: '/api/me' })).json()).toEqual({ authRequired: false, username: null });
    const r = await a.inject({ method: 'POST', url: '/api/login', payload: { username: 'Sam', password: '' } });
    expect(r.statusCode).toBe(200);
    expect((await a.inject({ url: '/api/me', headers: { cookie: cookieOf(r.headers['set-cookie']) } })).json().username).toBe('Sam');
  });
});

describe('ledger', () => {
  it('expected cost and profit: an amount on the card is copied exactly, another is scaled from best per unit', () => {
    const d = { best: { units: 5, cost: 1000, expectedProfit: 1500 }, options: [{ units: 2, cost: 400, expectedProfit: 600 }, { units: 5, cost: 1000, expectedProfit: 1500 }, { units: 10, cost: 2000, expectedProfit: 2200 }] };
    expect(expectedFor(d, 10)).toEqual({ cost: 2000, profit: 2200 }); // most, not 10 x 300
    expect(expectedFor(d, 3)).toEqual({ cost: 600, profit: 900 }); // 3 x 200 and 3 x 300
    expect(expectedFor(d, 7)).toEqual({ cost: 1400, profit: 2100 });
    expect(expectedFor({ best: { units: 0, cost: 0, expectedProfit: 0 }, perItem: 250 }, 4)).toEqual({ cost: 0, profit: 1000 });
  });
  it('per person totals by hand', () => {
    const row = (p: Partial<ActionRow>): ActionRow => ({ id: 0, action: 'did', did_id: null, flip_key: 'k', username: 'Chip', at: 0, units: 1, expected_cost: null, expected_profit: null, received: null, item_id: null, name: null, kind: null, house_id: null, ...p });
    const t = ledgerTotals([
      row({ id: 1, units: 5, expected_cost: 1000, expected_profit: 1500 }),
      row({ id: 2, units: 2, expected_cost: 400, expected_profit: 600 }),
      row({ id: 3, action: 'sold', did_id: 1, units: 5, received: 2300 }),
      row({ id: 4, action: 'sold', did_id: 2, units: 1, received: 450 }),
      row({ id: 5, username: 'Sam', units: 10, expected_cost: 2000, expected_profit: 2200 }),
    ]);
    // Chip: spent 1000 + 400 = 1400, received 2300 + 450 = 2750, realised 1350, expected 2100, 1350 / 2100 = 0.642857
    const chip = t.find(p => p.username === 'Chip')!;
    expect(chip).toMatchObject({ flipsDone: 2, unitsDone: 7, unitsSold: 6, spent: 1400, received: 2750, realised: 1350, expected: 2100 });
    expect(chip.realisedVsExpected).toBeCloseTo(1350 / 2100, 10);
    // Sam: nothing sold yet, so realised is minus what was spent
    expect(t.find(p => p.username === 'Sam')).toMatchObject({ flipsDone: 1, spent: 2000, received: 0, realised: -2000, expected: 2200 });
    expect(t.map(p => p.username)).toEqual(['Chip', 'Sam']);
    expect(ledgerTotals([row({ expected_profit: 0, expected_cost: 10 })])[0]!.realisedVsExpected).toBeNull();
  });
  it('I did this copies the flip at that moment, Sold links to it, and GET /api/ledger adds it up', async () => {
    const db = openDb(tempDir(), ':memory:');
    const key = addFlip(db);
    const a = app(db);
    const auth = makeAuth({ password: PW, secret: SECRET });
    const chip = { cookie: `${COOKIE}=${auth.sign('Chip')}` }, sam = { cookie: `${COOKIE}=${auth.sign('Sam')}` };
    const did = (await a.inject({ method: 'POST', url: `/api/flips/${encodeURIComponent(key)}/did`, headers: chip, payload: { units: 3 } })).json();
    expect(did).toMatchObject({ ok: true, units: 3, expectedCost: 600, expectedProfit: 900 });
    // The flip changes later; the record keeps what it said then.
    db.prepare(`UPDATE flips SET detail = json_set(detail, '$.best.cost', 99999) WHERE key = ?`).run(key);
    expect((await a.inject({ method: 'POST', url: `/api/flips/${encodeURIComponent(key)}/did`, headers: sam, payload: { units: 10 } })).json()).toMatchObject({ expectedCost: 2000, expectedProfit: 2200 });
    expect((await a.inject({ method: 'POST', url: `/api/ledger/${did.id}/sold`, headers: sam, payload: { units: 1, received: 1 } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: `/api/ledger/${did.id}/sold`, headers: chip, payload: { units: 4, received: 1 } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: `/api/ledger/${did.id}/sold`, headers: chip, payload: { units: 2, received: 1000 } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'POST', url: `/api/ledger/${did.id}/sold`, headers: chip, payload: { units: 2, received: 1 } })).json().error).toMatch(/Only 1 of 3/);
    expect((await a.inject({ method: 'POST', url: `/api/ledger/${did.id}/sold`, headers: chip, payload: { units: 1, received: 400 } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'POST', url: '/api/flips/nope/did', headers: chip, payload: { units: 1 } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: `/api/flips/${encodeURIComponent(key)}/did`, headers: chip, payload: { units: 1.5 } })).statusCode).toBe(400);
    const l = (await a.inject({ url: '/api/ledger', headers: chip })).json();
    expect(l.me).toBe('Chip');
    // Chip: spent 600, received 1400, realised 800 against 900 expected
    expect(l.people.find((p: any) => p.username === 'Chip')).toMatchObject({ flipsDone: 1, spent: 600, received: 1400, realised: 800, expected: 900 });
    expect(l.people.find((p: any) => p.username === 'Sam')).toMatchObject({ flipsDone: 1, spent: 2000, received: 0, realised: -2000 });
    expect(l.mine).toHaveLength(1);
    expect(l.mine[0]).toMatchObject({ flip_key: key, units: 3, soldUnits: 3, soldReceived: 1400, name: 'Heavy Linen Bandage', username: 'Chip' });
    expect(l.history.map((h: any) => `${h.username} ${h.action} ${h.units}`)).toEqual(['Chip sold 1', 'Chip sold 2', 'Sam did 10', 'Chip did 3']);
  });
  it('with login off, actions are recorded as "local"', async () => {
    const db = openDb(tempDir(), ':memory:');
    const key = addFlip(db);
    const a = app(db, null);
    await a.inject({ method: 'POST', url: `/api/flips/${encodeURIComponent(key)}/did`, payload: { units: 5 } });
    expect((await a.inject({ url: '/api/ledger' })).json().people[0]).toMatchObject({ username: 'local', spent: 1000, expected: 1500 });
  });
});
