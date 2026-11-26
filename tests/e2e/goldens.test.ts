/**
 * End to end yardsticks (docs/handoff/brief-system-r1.md, agent A). The whole pipeline with nothing stubbed but
 * Blizzard's HTTP: the real Collector polls each publish (aggregate), rebuildHistory re-counts them, demandByItem reads
 * the sales, hourlyFlips ranks and stores, and /api/flips serves it through buildServer().inject().
 *
 * Fixture (tests/e2e/fixtures/goldens.json.gz, cut by cut-goldens.ts): two real consecutive publishes of houses 111
 * and 116, both kinds, for 150 real background items, plus the real listings of the yardstick items. From them, 24
 * hourly publishes are built by shifting time: the background is publish A for hours 0 to 22 and publish B at hour 23,
 * so the last hour is real churn. Yardstick ladders are stated here and buys are injected hour by hour, cheapest first
 * and newest first at one price, as the buy window fills. One extra publish three days earlier holds the yardstick
 * ladders at their opening prices (fresh listing ids), so 72 hours of floors stand behind the bad case.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { openDb, type DB } from '../../src/store/db.ts';
import { Collector, type Kind } from '../../src/engine/collector.ts';
import { rebuildHistory } from '../../src/engine/rebuild.ts';
import { demandByItem } from '../../src/analysis/history.ts';
import { hourlyFlips } from '../../src/flips/hourly.ts';
import type { FlipRunResult } from '../../src/flips/run.ts';
import type { Flip } from '../../src/flips/types.ts';
import { buildServer } from '../../src/server/server.ts';
import type { Listing, TimeLeft } from '../../src/analysis/aggregate.ts';
import type { HouseRow } from '../../src/engine/houses.ts';
import { tempDir, fakeBlizzard } from '../helpers.ts';

const H = 3600_000;
const TL: TimeLeft[] = ['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG'];
const FIX = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/goldens.json.gz', import.meta.url))).toString()) as {
  houses: Array<Record<string, unknown>>;
  snapshots: Array<{ house: number; kind: Kind; at: number; listings: number[][]; yard: number[][] }>;
  items: Array<Record<string, unknown>>; recipes: Array<Record<string, unknown>>; recipe_reagents: Array<Record<string, unknown>>;
  vendor_items: Array<Record<string, unknown>>; trainer_spells: Array<Record<string, unknown>>; background: number[]; backgroundRecipes: number[];
};

// Item and recipe ids from the game.
const LICHEN = 249399, VIAL = 3371, DYE = 249409, BAUBLES = 6532, HELM = 12640;
const WATER = 7080, AIR = 7082, POISON = 6947, DUST = 2928, DYNAMITE = 4378, WOOL = 2592, POWDER = 4377;
const DYE_RECIPE = 54453, TRANSMUTE = 9948, POISON_RECIPE = 4807, DYNAMITE_RECIPE = 2442;
const HOURS = 23; // publishes at hours 0..23: 23 differenced hours

const fromRow = (r: number[]): Listing => ({ id: r[0]!, itemId: r[1]!, quantity: r[2]!, unitPrice: r[3] === -1 ? null : r[3]!, timeLeft: TL[r[4]!] ?? 'LONG' });

/** One stated ladder: stacks of [price, units], where it sits, and units bought each hour (index 0 is hour 0 to 1). */
interface Stock { house: number; kind: Kind; itemId: number; ladder: Array<[number, number]>; buys?: number[];
  /** sellers restock: every `every` hours a stack of `units` at `price` */
  restock?: { every: number; price: number; units: number } }

interface Scenario {
  /** stated ladders; an item with none keeps its real listings ('today') or has none */
  stocks: Stock[];
  /** keep the real yardstick listings (today's prices) instead of stated ladders */
  real?: boolean;
}

let nextId = 4_000_000_000;

/** Hourly listings of one stated stock: listing ages and time left move with the clock, buys walk the buy order. */
function simulate(s: Stock, base: number): Array<Listing[]> {
  type L = Listing & { posted: number };
  const post = (price: number, units: number, at: number): L => ({ id: nextId++, itemId: s.itemId, quantity: units, unitPrice: price, timeLeft: 'VERY_LONG', posted: at });
  let live: L[] = s.ladder.map(([p, u]) => post(p, u, base));
  const out: Array<Listing[]> = [];
  const left = (l: L, at: number): TimeLeft => { const h = 24 - (at - l.posted) / H; return h > 12 ? 'VERY_LONG' : h > 2 ? 'LONG' : h > 0.5 ? 'MEDIUM' : 'SHORT'; };
  for (let k = 0; k <= HOURS; k++) {
    const at = base + k * H;
    if (k > 0) {
      let want = s.buys?.[k - 1] ?? 0;
      // The buy window: cheapest first, and at one price the newest listing first.
      const order = [...live].sort((a, b) => a.unitPrice! - b.unitPrice! || b.id - a.id);
      for (const l of order) {
        if (want <= 0) break;
        const take = Math.min(want, l.quantity);
        want -= take;
        l.quantity -= take;
      }
      if (want > 0) throw new Error(`stock ${s.itemId} ran out at hour ${k}`);
      live = live.filter(l => l.quantity > 0);
      if (s.restock && k % s.restock.every === 0) live.push(post(s.restock.price, s.restock.units, at));
    }
    out.push(live.map(l => ({ id: l.id, itemId: l.itemId, quantity: l.quantity, unitPrice: l.unitPrice, timeLeft: s.kind === 'auctions' ? 'VERY_LONG' : left(l, at) })));
  }
  return out;
}

interface World { db: DB; dir: string; collector: Collector; lastAt: number; injected: Map<string, number> }

/** Build one world: catalog, 25 publishes per house and kind polled through the real collector, then a rebuild. */
async function build(sc: Scenario): Promise<World> {
  const dir = tempDir();
  const db = openDb(dir);
  const insert = (table: string, rows: Array<Record<string, unknown>>) => {
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    for (const r of rows) {
      const keys = Object.keys(r).filter(k => cols.has(k));
      db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => r[k] as never));
    }
  };
  insert('houses', FIX.houses);
  db.exec('UPDATE houses SET pinned = 1 WHERE id IN (111, 116)');
  insert('items', FIX.items);
  insert('recipes', FIX.recipes);
  insert('recipe_reagents', FIX.recipe_reagents);
  insert('vendor_items', FIX.vendor_items);
  insert('trainer_spells', FIX.trainer_spells);

  const real = (house: number, kind: Kind, which: 0 | 1, field: 'listings' | 'yard') =>
    FIX.snapshots.filter(s => s.house === house && s.kind === kind).sort((a, b) => a.at - b.at)[which]![field].map(fromRow);
  const end = (house: number) => FIX.snapshots.filter(s => s.house === house).reduce((m, s) => Math.max(m, s.at), 0);
  const lastAt = Math.max(end(111), end(116));
  const base = lastAt - HOURS * H;
  const sims = sc.stocks.map(s => ({ s, hours: simulate(s, base) }));
  const injected = new Map<string, number>();
  for (const { s } of sims) injected.set(`${s.house}:${s.itemId}`, (injected.get(`${s.house}:${s.itemId}`) ?? 0) + (s.buys ?? []).reduce((a, b) => a + b, 0));

  // Publish times per hour: hour 0 three days before hour 23 is the opening publish, then hours 0..23.
  const times = [base - 52 * H, ...Array.from({ length: HOURS + 1 }, (_, k) => base + k * H)];
  const listingsAt = (house: number, kind: Kind, i: number): Listing[] => {
    if (i === 0) {
      // Three days back: the stated ladders at their opening prices under fresh listing ids, no background.
      return sims.filter(x => x.s.house === house && x.s.kind === kind).flatMap(x => x.s.ladder.map(([p, u]) => ({ id: nextId++, itemId: x.s.itemId, quantity: u, unitPrice: p as number | null, timeLeft: 'LONG' as TimeLeft })))
        .concat(sc.real ? real(house, kind, 0, 'yard').map(l => ({ ...l, id: l.id + 3_000_000_000 })) : []);
    }
    const k = i - 1;
    const which = k === HOURS ? 1 : 0;
    const ls = real(house, kind, which, 'listings');
    if (sc.real) ls.push(...real(house, kind, which, 'yard'));
    for (const x of sims) if (x.s.house === house && x.s.kind === kind) ls.push(...x.hours[k]!);
    return ls;
  };

  let i = 0;
  const routes: Record<string, () => { body: unknown; lastModified: string }> = {};
  for (const house of [111, 116]) {
    routes[`/data/wow/ruleset/2/auctions/${house}`] = () => ({ lastModified: new Date(times[i]!).toUTCString(), body: { id: house,
      auctions: listingsAt(house, 'auctions', i).map(l => ({ id: l.id, item: { id: l.itemId }, buyout: l.unitPrice! * l.quantity, quantity: l.quantity, time_left: l.timeLeft })) } });
    routes[`/data/wow/ruleset/2/auctions/${house}/commodities`] = () => ({ lastModified: new Date(times[i]!).toUTCString(), body: {
      auctions: listingsAt(house, 'commodities', i).map(l => ({ id: l.id, item: { id: l.itemId }, quantity: l.quantity, unit_price: l.unitPrice, time_left: l.timeLeft })) } });
  }
  const { client } = fakeBlizzard(routes);
  const collector = new Collector(client, db, dir);
  const houses = db.prepare('SELECT * FROM houses ORDER BY id').all() as unknown as HouseRow[];
  for (i = 0; i < times.length; i++) for (const h of houses) for (const kind of ['auctions', 'commodities'] as Kind[]) await collector.poll(h, kind);
  rebuildHistory(db);
  return { db, dir, collector, lastAt, injected };
}

interface Outcome { world: World; res: FlipRunResult; api: { flips: Array<Record<string, unknown> & { detail: Flip }>; run: { complete: boolean; report: FlipRunResult['report'] } | null; heldBack: Array<Record<string, unknown>> } }

async function runAt(world: World, now = world.lastAt + 10 * 60_000): Promise<Outcome> {
  const res = hourlyFlips(world.db, (h, k) => world.collector.listings(h, k), now)!;
  const app = buildServer({ db: world.db, engine: null, client: null, port: 0, dataDir: world.dir });
  const r = await app.inject({ method: 'GET', url: '/api/flips' });
  await app.close();
  expect(r.statusCode).toBe(200);
  return { world, res, api: r.json() };
}

// Stated ladders. Money is copper.
/** Ben's lichen: 25s to 30s with depth. */
const lichenAt = (p0: number): Stock => ({ house: 111, kind: 'commodities', itemId: LICHEN, ladder: [[p0, 2], [p0 + 200, 4], [p0 + 300, 10], [p0 + 400, 20], [p0 + 500, 40]] });
/** About 60 dye a day, sold 70s to 80s, with a seller restocking 2 every 4 hours. */
const DYE_BUYS = [2, 3, 2, 4, 1, 3, 2, 3, 2, 3, 2, 4, 2, 3, 2, 3, 1, 3, 2, 3, 2, 3, 2];
const dye = (buys = DYE_BUYS, extra: Array<[number, number]> = []): Stock => ({ house: 111, kind: 'commodities', itemId: DYE,
  ladder: [[7400, 10], [7500, 15], [7550, 15], [7600, 15], [7700, 15], [7800, 10], [8000, 10], ...extra], buys, restock: { every: 4, price: 7550, units: 2 } });
/** Bright Baubles on the Blackwater house near 5s, about 2 an hour. */
const BAUBLE_BUYS = [2, 1, 3, 2, 2, 1, 2, 3, 2, 2, 1, 2, 2, 3, 1, 2, 2, 2, 1, 3, 2, 2, 2];
const baubles = (buys = BAUBLE_BUYS): Stock => ({ house: 116, kind: 'commodities', itemId: BAUBLES, ladder: [[480, 10], [490, 10], [500, 20], [510, 20], [520, 20], [540, 20]], buys });
/** Junk that would look like money: each must stay out for its own reason. */
const junk: Stock[] = [
  // Lionheart Helm, 3 listings: one copy at 100g under two at 596g, nothing sold.
  { house: 111, kind: 'auctions', itemId: HELM, ladder: [[1_000_000, 1], [5_959_998, 1], [5_959_998, 1]] },
  // Transmute Water to Air: water at 1g, air at 5g selling 1 an hour. A 23 hour cooldown allows one cast.
  { house: 111, kind: 'commodities', itemId: WATER, ladder: [[10_000, 10], [10_500, 10]] },
  { house: 111, kind: 'commodities', itemId: AIR, ladder: [[50_000, 10], [50_500, 10], [51_000, 10]], buys: Array(HOURS).fill(1) },
  // Instant Poison binds on pickup: listings and sales stated anyway, the product still cannot be sold.
  // Reagents priced over their vendor sell price (Dust 5c, Wool 33c, Powder 150c), so none is an auction to vendor flip itself.
  { house: 111, kind: 'commodities', itemId: DUST, ladder: [[6, 100]] },
  { house: 111, kind: 'commodities', itemId: POISON, ladder: [[5000, 40], [5100, 40]], buys: Array(HOURS).fill(2) },
  // Heavy Dynamite yields 1 to 7 at random: reagents 3.6s a craft, the product 5s selling 2 an hour.
  { house: 111, kind: 'commodities', itemId: WOOL, ladder: [[40, 200]] },
  { house: 111, kind: 'commodities', itemId: POWDER, ladder: [[160, 400]] },
  { house: 111, kind: 'commodities', itemId: DYNAMITE, ladder: [[500, 40], [510, 40]], buys: Array(HOURS).fill(2) },
];
const bens = (over: Partial<Record<'lichen' | 'dye' | 'baubles', Stock>> = {}): Scenario => ({
  stocks: [over.lichen ?? lichenAt(2500), over.dye ?? dye(), over.baubles ?? baubles(), ...junk],
});

const dyeFlip = (o: Outcome) => o.res.flips.find(f => f.recipeId === DYE_RECIPE && f.sellHouseId === 111);
const baublesFlip = (o: Outcome) => o.res.flips.find(f => f.itemId === BAUBLES && f.family === 'vendor_auction' && f.sellHouseId === 116);
const held = (o: Outcome, pred: (h: FlipRunResult['heldBack'][number]) => boolean) => o.res.heldBack.filter(pred);
/** A reason Chip can read: words, no code values leaking through. */
const plain = (s: string) => /^[A-Za-z0-9]/.test(s) && !/undefined|NaN|null|\[object/.test(s) && s.split(' ').length >= 3;

const W: Record<string, Outcome> = {};
beforeAll(async () => {
  const scenarios: Record<string, Scenario> = {
    bens: bens(),
    today: { stocks: [], real: true },
    lichen36: bens({ lichen: lichenAt(3600) }),
    dye1: bens({ dye: dye(Array.from({ length: HOURS }, (_, k) => (k === 11 ? 1 : 0))) }),
    troll1: bens({ dye: dye(DYE_BUYS, [[50_000, 1]]) }),
    troll3: bens({ dye: dye(DYE_BUYS, [[50_000, 1], [50_000, 1], [50_000, 1]]) }),
    baublesNone: bens({ baubles: baubles(Array(HOURS).fill(0)) }),
  };
  for (const [name, sc] of Object.entries(scenarios)) W[name] = await runAt(await build(sc));
  // GOLDENS_DUMP=<file>: what each world ranked and held back for the yardstick items, for a reviewer to read.
  if (process.env.GOLDENS_DUMP) {
    const ids = new Set([LICHEN, VIAL, DYE, BAUBLES, HELM, WATER, AIR, POISON, DYNAMITE]);
    const recs = new Set([DYE_RECIPE, TRANSMUTE, POISON_RECIPE, DYNAMITE_RECIPE]);
    const mine = (x: { itemId: number; recipeId?: number }) => ids.has(x.itemId) || (x.recipeId != null && recs.has(x.recipeId));
    writeFileSync(process.env.GOLDENS_DUMP, JSON.stringify(Object.fromEntries(Object.entries(W).map(([k, o]) => [k, {
      report: o.res.report,
      top: o.res.flips.slice(0, 15).map(f => ({ rank: f.rank, key: f.key, kind: f.kind, units: f.best.units, expected: f.best.expectedProfit, perItem: f.perItem, risk: f.best.risk.level })),
      yard: o.res.flips.filter(mine).map(f => ({ rank: f.rank, key: f.key, units: f.best.units, options: f.options.map(x => x.units), expected: f.best.expectedProfit, perItem: f.perItem, risk: f.best.risk, quote: f.sellQuote })),
      held: o.res.heldBack.filter(mine),
    }])), null, 1));
  }
}, 240_000);

describe('the pipeline counts what was injected', () => {
  it('demandByItem reads exactly the units bought, over 23 watched hours, and the rebuild agrees with the collector', () => {
    const w = W.bens!.world;
    const d111 = demandByItem(w.db, 111, { now: w.lastAt + 600_000 });
    const d116 = demandByItem(w.db, 116, { now: w.lastAt + 600_000 });
    expect(d111.get(DYE)!.hoursWatched).toBeGreaterThanOrEqual(22);
    expect(d111.get(DYE)!.soldUnits).toBe(w.injected.get(`111:${DYE}`));
    expect(d116.get(BAUBLES)!.soldUnits).toBe(w.injected.get(`116:${BAUBLES}`));
    // Nothing of the lichen was bought: zero sold is the stated market fact here.
    expect(d111.get(LICHEN)?.soldUnits ?? 0).toBe(0);
    // Rebuild then a second rebuild: the same counts (the history is re-counted from raw, not added to).
    const before = w.db.prepare('SELECT SUM(sold_units) s FROM item_stats WHERE house_id = 111 AND item_id = ?').get(DYE) as { s: number };
    rebuildHistory(w.db);
    const after = w.db.prepare('SELECT SUM(sold_units) s FROM item_stats WHERE house_id = 111 AND item_id = ?').get(DYE) as { s: number };
    expect(after.s).toBe(before.s);
    expect(before.s).toBe(w.injected.get(`111:${DYE}`));
  });
});

describe('1. Cerulean Dye at Ben\'s prices', () => {
  it('a green craft in the top 10, medium or low risk, buying lichen at auction and vials from a vendor', () => {
    const o = W.bens!;
    const f = dyeFlip(o);
    expect(f, `held back: ${held(o, h => h.recipeId === DYE_RECIPE).map(h => h.reason).join('; ')}`).toBeDefined();
    expect(f!.kind).toBe('craft');
    expect(f!.family).toBe('craft_auction');
    expect(f!.rank!).toBeLessThanOrEqual(10);
    expect(['low', 'medium']).toContain(f!.best.risk.level);
    expect(f!.best.expectedProfit).toBeGreaterThan(0);
    expect(f!.buy.find(l => l.itemId === LICHEN)!.kind).toBe('auction');
    const vial = f!.buy.find(l => l.itemId === VIAL)!;
    expect(vial.kind).toBe('vendor');
    expect(vial.unitPrice).toBeCloseTo(4, 5);
    // Claimed price inside where the dye really sold.
    expect(f!.sellQuote.claimPrice).toBeGreaterThanOrEqual(7000);
    expect(f!.sellQuote.claimPrice).toBeLessThanOrEqual(8000);
    // The same flip reaches the page, ranked the same.
    const row = o.api.flips.find(r => r.key === f!.key)!;
    expect(row).toBeDefined();
    expect(row.kind).toBe('craft');
    expect(row.rank).toBe(f!.rank);
    expect(row.risk).toBe(f!.best.risk.level);
  });
});

describe('2. Bright Baubles from Old Man Heming to the Blackwater house', () => {
  it('with about 2 sold an hour near 5s it shows, bought at 250c, with the 15 percent cut', () => {
    const o = W.bens!;
    const f = baublesFlip(o);
    expect(f, `held back: ${held(o, h => h.itemId === BAUBLES).map(h => h.reason).join('; ')}`).toBeDefined();
    expect(f!.kind).toBe('flip');
    const buy = f!.buy[0]!;
    expect(buy.kind).toBe('vendor');
    expect(buy.who).toMatch(/Old Man Heming/);
    expect(buy.unitPrice).toBe(250);
    const q = f!.sellQuote;
    expect(q.claimPrice).toBeGreaterThanOrEqual(470);
    expect(q.claimPrice).toBeLessThanOrEqual(540);
    // Chip posts one typical undercut under the claim; the mailbox gets that less the 15 percent Blackwater cut.
    expect(q.undercutPrice).toBeLessThan(q.claimPrice);
    expect(q.netEach).toBe(Math.floor(q.undercutPrice * 0.85));
    expect(f!.perItem).toBeLessThanOrEqual(q.netEach - 250);
    expect(o.api.flips.some(r => r.key === f!.key)).toBe(true);
  });
  it('with nothing sold it is held back, and the reason says no sales were seen', () => {
    const o = W.baublesNone!;
    expect(baublesFlip(o)).toBeUndefined();
    const h = held(o, x => x.itemId === BAUBLES && x.sellHouseId === 116);
    expect(h.length).toBeGreaterThan(0);
    expect(h.map(x => x.reason).join('; ')).toMatch(/no sales/i);
    for (const x of h) expect(plain(x.reason)).toBe(true);
  });
});

describe('3. Today\'s prices', () => {
  it('both are held back with a plain reason', () => {
    const o = W.today!;
    expect(o.res.report.complete).toBe(true);
    expect(dyeFlip(o)).toBeUndefined();
    expect(baublesFlip(o)).toBeUndefined();
    const dyeHeld = held(o, h => h.recipeId === DYE_RECIPE);
    const bHeld = held(o, h => h.itemId === BAUBLES && h.sellHouseId === 116);
    expect(dyeHeld.length, 'the dye is held back with a reason, not silently dropped').toBeGreaterThan(0);
    expect(bHeld.length, 'the baubles are held back with a reason, not silently dropped').toBeGreaterThan(0);
    for (const h of [...dyeHeld, ...bHeld]) expect(plain(h.reason), h.reason).toBe(true);
    // Lichen at 33s and the dye at 69.5s: two lichen cost what the dye nets. The baubles: nothing sold near the price.
    expect(dyeHeld.find(h => h.sellHouseId === 111)!.reason).toMatch(/no profit/);
    expect(bHeld.map(h => h.reason).join('; ')).toMatch(/no sales/);
  });
});

describe('4. Near misses', () => {
  it('lichen at 36s: the dye craft is gone', () => {
    const o = W.lichen36!;
    expect(dyeFlip(o)).toBeUndefined();
    expect(o.api.flips.some(r => r.recipe_id === DYE_RECIPE)).toBe(false);
  });
  it('dye selling 1 a day: weak or gone', () => {
    const o = W.dye1!;
    const f = dyeFlip(o);
    const strong = dyeFlip(W.bens!)!;
    if (f) {
      expect(f.best.risk.level).not.toBe('low');
      expect(f.best.units).toBeLessThanOrEqual(2);
      expect(f.best.expectedProfit).toBeLessThan(strong.best.expectedProfit / 4);
    }
  });
  for (const [name, label] of [['troll1', 'one troll dye listing at 5g'], ['troll3', 'three troll dye listings at 5g']] as const) {
    it(`${label}: claimed price unchanged`, () => {
      const a = dyeFlip(W.bens!)!, b = dyeFlip(W[name]!);
      expect(b).toBeDefined();
      expect(b!.sellQuote.claimPrice).toBe(a.sellQuote.claimPrice);
      expect(b!.sellQuote.listed).toBe(a.sellQuote.listed);
    });
    // ENGINE BUG (findings-system-r1-A.txt, finding 1): typicalUndercut (src/flips/sellBook.ts) takes the median gap of
    // the cheapest 6 price levels with no limit on how far above the claim a level sits. A 5g troll over a 76s to 80s
    // ladder adds a 42,000c gap, the median moves from 100c to 150c, and the post price and net drop by about 50c.
    it.fails(`${label}: post price and net unchanged`, () => {
      const a = dyeFlip(W.bens!)!, b = dyeFlip(W[name]!)!;
      expect(b.sellQuote.undercutPrice).toBe(a.sellQuote.undercutPrice);
      expect(b.sellQuote.netEach).toBe(a.sellQuote.netEach);
    });
  }
});

describe('5. Junk stays out', () => {
  it('Lionheart Helm on 3 listings: no flip', () => {
    const o = W.bens!;
    expect(o.res.flips.filter(f => f.itemId === HELM)).toEqual([]);
  });
  it('a transmute past its cooldown: never more than one cast', () => {
    const o = W.bens!;
    expect(o.res.flips.some(x => x.recipeId === TRANSMUTE), 'the transmute is tempting here: 1g in, 5g out').toBe(true);
    for (const f of o.res.flips.filter(x => x.recipeId === TRANSMUTE)) {
      expect(f.best.units).toBeLessThanOrEqual(1);
      for (const op of f.options) expect(op.units, `${op.label} option`).toBeLessThanOrEqual(1);
    }
  });
  it('a bind on pickup product: no flip, held back for binding', () => {
    const o = W.bens!;
    expect(o.res.flips.filter(f => f.itemId === POISON || f.recipeId === POISON_RECIPE)).toEqual([]);
    const h = held(o, x => x.recipeId === POISON_RECIPE && x.sellHouseId === 111);
    expect(h.map(x => x.reason).join('; ')).toMatch(/binds on pickup/);
  });
  it('a random yield product: no flip, held back for its yield', () => {
    const o = W.bens!;
    expect(o.res.flips.filter(f => f.recipeId === DYNAMITE_RECIPE)).toEqual([]);
    const h = held(o, x => x.recipeId === DYNAMITE_RECIPE);
    expect(h.length).toBeGreaterThan(0);
    expect(h.map(x => x.reason).join('; ')).toMatch(/random|yield/i);
  });
});

describe('6. Run report', () => {
  it('complete on fresh data: every house, the counts agree with the list and the page', () => {
    const o = W.bens!;
    const rep = o.res.report;
    expect(rep.complete).toBe(true);
    expect(rep.incompleteReason).toBeUndefined();
    expect(rep.houses.sort()).toEqual([111, 116]);
    expect(rep.flips).toBe(o.res.flips.length);
    expect(Object.values(rep.byFamily).reduce((a, b) => a + b, 0)).toBe(rep.flips);
    expect(o.api.run!.complete).toBe(true);
    expect(o.api.flips.length).toBe(rep.flips);
    expect(new Set(o.api.flips.map(r => r.key))).toEqual(new Set(o.res.flips.map(f => f.key)));
  });
  it('incomplete when the data is stale: the reason names the age, no list is shown', async () => {
    const w = W.bens!.world;
    const o = await runAt(w, w.lastAt + 3 * H);
    expect(o.res.report.complete).toBe(false);
    expect(o.res.report.incompleteReason).toMatch(/data is 3(\.\d)? hours old/);
    expect(o.res.flips).toEqual([]);
    expect(o.api.run!.complete).toBe(false);
    expect(o.api.run!.report.incompleteReason).toMatch(/hours old/);
  });
  // ENGINE BUG? (findings-system-r1-A.txt, finding 2): persistFlips returns before touching the flips table when a run is
  // incomplete, so /api/flips keeps serving the last complete run's cards next to the incomplete chip. hourlyFlips says a
  // failed run is stored "so the page says so instead of showing an old or partial list as if it were current".
  it.fails('incomplete when the data is stale: the page gets no cards from an older run', async () => {
    const w = W.bens!.world;
    const o = await runAt(w, w.lastAt + 3 * H);
    expect(o.api.run!.complete).toBe(false);
    expect(o.api.flips).toEqual([]);
  });
});
