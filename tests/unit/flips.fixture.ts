/**
 * Hand built flip engine inputs. Every number in a test is stated here or in the test, so each gate passes or
 * fails for a reason you can read. Money is copper.
 */
import type { Listing } from '../../src/analysis/aggregate.ts';
import type { FlipDemand, FlipInputs, FlipItem, FlipRecipe, VendorSource } from '../../src/flips/inputs.ts';
import type { HouseRef } from '../../src/flips/types.ts';
import { Market } from '../../src/flips/market.ts';
import { SellBook } from '../../src/flips/sellBook.ts';
import { generate } from '../../src/flips/families.ts';
import { evaluate } from '../../src/flips/evaluate.ts';
import { runFlips } from '../../src/flips/run.ts';

export const A: HouseRef = { id: 111, name: 'Alliance Auction House', faction: 'alliance', cut: 0.05, publishedAt: 1_000 };
export const B: HouseRef = { id: 116, name: 'Blackwater Auction House', faction: 'blackwater', cut: 0.15, publishedAt: 1_000 };

let nid = 1;
/** One listing of `qty` units at `price` each. */
export const L = (itemId: number, price: number, qty = 1): Listing => ({ id: nid++, itemId, quantity: qty, unitPrice: price, timeLeft: 'LONG' });
/** `n` listings of `qty` each at one price. */
export const many = (itemId: number, price: number, n: number, qty = 1) => Array.from({ length: n }, () => L(itemId, price, qty));

export const item = (id: number, name: string, sellPrice: number | null, extra: Partial<FlipItem> = {}): FlipItem =>
  ({ id, name, sellPrice, binding: null, bonding: 0, quality: 'COMMON', stackSize: 20, vendorStack: null, purchaseQuantity: null, ...extra });

export const vendor = (npcName: string, unitPrice: number, bundle = 1, limited = false): VendorSource =>
  ({ npcId: nid++, npcName, zone: 'Elwynn Forest', places: [{ label: npcName, zone: 'Elwynn Forest', uiMap: 1429, x: 40, y: 60 }], unitPrice, bundle, limited, minStanding: 4 });

export const recipe = (id: number, name: string, productId: number, reagents: Array<[number, number]>, extra: Partial<FlipRecipe> = {}): FlipRecipe => ({
  id, name, profession: 'Alchemy', productId, qtyMin: 1, qtyMax: 1, learnSkill: 1, spellId: null, castMs: 3000, cooldownMs: null, cooldownCategory: null,
  randomYield: false, live: true, kind: 'profession', reagents: reagents.map(([itemId, quantity]) => ({ itemId, quantity })), ...extra,
});

/** A market that sells, with every field stated: sold `units` a day seen over `hours`, cautious low and new posts given. */
export const sells = (unitsPerDay: number, soldPrice: number, extra: Partial<FlipDemand> = {}): FlipDemand => ({
  unitsPerDay, hours: 72, snapshots: 72, soldPrice, recentSoldPrice: soldPrice, recentSales: Math.round(unitsPerDay), floorCv: 0.05, ...extra,
});

export interface Fixture {
  houses?: HouseRef[];
  listings: Record<number, Listing[]>;
  items: FlipItem[];
  vendors?: Record<number, VendorSource[]>;
  recipes?: FlipRecipe[];
  demand?: Record<number, Record<number, FlipDemand>>;
  typical?: Record<number, Record<number, number>>;
  settings?: Partial<FlipInputs['settings']>;
  recent?: string[];
}

export function inputsOf(f: Fixture): FlipInputs {
  const houses = (f.houses ?? [A]).map(h => ({ ...h }));
  const listings = new Map<number, Map<number, Listing[]>>();
  for (const h of houses) {
    const m = new Map<number, Listing[]>();
    for (const l of f.listings[h.id] ?? []) { const a = m.get(l.itemId) ?? []; a.push(l); m.set(l.itemId, a); }
    for (const a of m.values()) a.sort((x, y) => x.unitPrice! - y.unitPrice! || x.id - y.id);
    listings.set(h.id, m);
  }
  const vendors = new Map<number, VendorSource[]>();
  for (const [id, vs] of Object.entries(f.vendors ?? {})) vendors.set(Number(id), [...vs].sort((a, b) => Number(a.limited) - Number(b.limited) || a.unitPrice - b.unitPrice));
  const demand = new Map<number, Map<number, FlipDemand>>();
  for (const h of houses) demand.set(h.id, new Map(Object.entries(f.demand?.[h.id] ?? {}).map(([k, v]) => [Number(k), v])));
  const typical = new Map(houses.map(h => [h.id, new Map(Object.entries(f.typical?.[h.id] ?? {}).map(([k, v]) => [Number(k), { typicalFloor: v, readings: 48 }]))]));
  return {
    now: 2_000, houses, problems: [], notes: [], listings, items: new Map(f.items.map(i => [i.id, i])), vendors, recipes: f.recipes ?? [], demand, typical,
    low3d: new Map(houses.map(h => [h.id, new Map()])), drivers: new Map(), trainers: [], recipeItems: new Map(),
    history: { recent: new Set(f.recent ?? []), openHours: new Map() },
    settings: { timeRate: 0, goldOnHand: null, horizonHours: 10, craftSessionMinutes: 30, ...f.settings },
  };
}

/** Price one candidate standalone, the way runFlips does, and hand back its evaluation. */
export function evalKey(inputs: FlipInputs, key: string) {
  const market = new Market(inputs, inputs.recipes.filter(r => r.live && !r.randomYield && r.reagents.length));
  const book = new SellBook(inputs);
  const gen = generate(inputs, market, book);
  const c = gen.candidates.find(x => x.key === key);
  if (!c) throw new Error(`no candidate ${key}; held back: ${gen.heldBack.filter(h => h.key === key).map(h => h.reason).join(', ')}`);
  const recipes = new Map(inputs.recipes.map(r => [r.id, r]));
  return { e: evaluate(c, market, inputs, recipes, { capUsed: 0, gold: inputs.settings.goldOnHand, timeRate: inputs.settings.timeRate, horizonHours: inputs.settings.horizonHours, craftSessionMinutes: inputs.settings.craftSessionMinutes }), c, market };
}

export const run = (f: Fixture | FlipInputs) => runFlips('listings' in f && f.listings instanceof Map ? f as FlipInputs : inputsOf(f as Fixture));

// Item ids from the game, for readability.
export const LICHEN = 249399, VIAL = 3371, DYE = 249409, BAUBLES = 6532;
export const DYE_RECIPE = 54453;

/**
 * Cerulean Dye at Ben's prices (docs/flip-plan.md section 2). Frilled Lichen 25s to 30s with depth, Empty Vial from a
 * vendor at 4c a unit in bundles of 5 (20c per 5), the dye listed 75s to 80s and selling about 60 a day.
 */
export function ceruleanAtBens(over: { lichen?: Listing[]; dye?: Listing[]; dyeDemand?: Partial<FlipDemand>; extra?: Partial<Fixture> } = {}): Fixture {
  return {
    listings: {
      111: [
        ...(over.lichen ?? [L(LICHEN, 2500, 2), L(LICHEN, 2700, 4), L(LICHEN, 2800, 10), L(LICHEN, 2900, 20), L(LICHEN, 3000, 40)]),
        ...(over.dye ?? [L(DYE, 7500, 5), L(DYE, 7501, 5), L(DYE, 7550, 5), L(DYE, 7600, 5), L(DYE, 7800, 5), L(DYE, 8000, 5)]),
        ...(over.extra?.listings?.[111] ?? []),
      ],
      ...Object.fromEntries(Object.entries(over.extra?.listings ?? {}).filter(([k]) => k !== '111')),
    },
    items: [item(LICHEN, 'Frilled Lichen', 30, { quality: 'UNCOMMON' }), item(VIAL, 'Empty Vial', 1, { vendorStack: 5 }), item(DYE, 'Cerulean Dye', 75, { quality: 'UNCOMMON' }), ...(over.extra?.items ?? [])],
    vendors: { [VIAL]: [vendor('Tharynn Bouden', 4, 5)], ...(over.extra?.vendors ?? {}) },
    recipes: [recipe(DYE_RECIPE, 'Cerulean Dye', DYE, [[LICHEN, 2], [VIAL, 1]]), ...(over.extra?.recipes ?? [])],
    demand: { 111: { [DYE]: sells(60, 7550, { soldPrice: 7600, recentSoldPrice: 7550, recentSales: 20, lowPerDay: 60, newPerDay: 12, low3d: 7000, ...over.dyeDemand }), ...(over.extra?.demand?.[111] ?? {}) },
      ...Object.fromEntries(Object.entries(over.extra?.demand ?? {}).filter(([k]) => k !== '111')) },
    houses: over.extra?.houses, settings: over.extra?.settings, typical: over.extra?.typical, recent: over.extra?.recent,
  };
}

/** P(X >= j) for X ~ Poisson(mu), summed from the pmf directly: an independent check of src/flips/poisson.ts. */
export function refTail(mu: number, j: number): number {
  if (j <= 0) return 1;
  let p = Math.exp(-mu), cdf = 0;
  for (let i = 0; i < j; i++) { cdf += p; p *= mu / (i + 1); }
  return 1 - cdf;
}

/** Expected profit of n units at queue positions ahead + 1 .. ahead + n, `upe` units per sale event (plan section 6). */
export function refExpected(o: { mu: number; ahead: number; net: number; salvage: number; deposit: number; cost: number; n: number; upe?: number;
  /** carryover: the mean sale events over tonight and the next 24 hours together; unsold units are relisted when that pays */
  mu2?: number; shortTonight?: number; shortTomorrow?: number }): number {
  return refRevenue(o) - o.cost;
}

/** Units sold by queue position over a mean of `mu` events: positions ahead + 1 .. ahead + n. */
export function refSold(mu: number, ahead: number, n: number, upe = 1): number {
  let sold = 0;
  for (let k = 1; k <= n; k++) sold += refTail(mu, Math.ceil((ahead + k) / upe));
  return sold;
}

/**
 * What n posted units bring in, written out independently of src/flips/evaluate.ts settle: tonight's sales at the net,
 * then (with mu2) the unsold relisted for one more deposit and sold tomorrow through the same queue, when that beats
 * selling them to a vendor.
 */
export function refRevenue(o: { mu: number; ahead: number; net: number; salvage: number; deposit: number; n: number; upe?: number; mu2?: number; shortTonight?: number; shortTomorrow?: number }): number {
  const t1 = refSold(o.mu, o.ahead, o.n, o.upe);
  const s1 = t1 * (o.shortTonight ?? 1), left = o.n - s1;
  const keep = s1 * o.net + left * (o.salvage - o.deposit);
  if (o.mu2 == null) return keep;
  const s2 = Math.min(left, Math.max(0, refSold(o.mu2, o.ahead, o.n, o.upe) - t1) * (o.shortTomorrow ?? 1));
  const end = left - s2;
  return Math.max(keep, (s1 + s2) * o.net - left * o.deposit - end * (o.deposit - o.salvage));
}

/** The quantity with the most expected profit, by the independent recompute, for a flat unit cost (ties to fewer). */
export function refBest(o: { mu: number; mu2?: number; ahead: number; net: number; salvage: number; deposit: number; unitCost: number; maxN: number }): { n: number; e: number } {
  let best = { n: 1, e: -Infinity };
  for (let n = 1; n <= o.maxN; n++) {
    const e = refExpected({ ...o, cost: o.unitCost * n, n });
    if (e > best.e + 1e-9) best = { n, e };
  }
  return best;
}
