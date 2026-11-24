import type { DB } from '../store/db.ts';
import type { Listing } from '../analysis/aggregate.ts';
import type { Demand, Driver } from '../detectors/types.ts';
import type { Place } from '../datasets/places.ts';
import { demandByItem, typicalFloors, type Typical } from '../analysis/history.ts';
import { demandDrivers } from '../engine/context.ts';
import { UNDERPRICED } from '../rules/thresholds.ts';
import { GOLD_SETTING, HORIZON_HOURS, OPENING, TIME_RATE_DEFAULT, TIME_RATE_SETTING, TRANSMUTE_FALLBACK, VENDOR_MAX_STANDING } from '../rules/flips.ts';
import { chipHousesWithNotes } from './houses.ts';
import type { HouseRef } from './types.ts';

/**
 * Sale counting's demand, plus the fields the sale counting fixes add (all optional, so the engine runs before and
 * after they land). Every reader falls back to a cautious estimate when one is missing.
 */
export type FlipDemand = Demand & {
  /** cautious (low) units sold a day */
  lowPerDay?: number | null;
  /** new units other sellers post at or under the floor, a day */
  newPerDay?: number | null;
  /** highest unit price buyers paid in the last hour */
  sweepHigh?: number | null;
  /** lowest hourly floor over the last 3 days */
  low3d?: number | null;
};

export interface FlipItem {
  id: number; name: string; sellPrice: number | null; binding: string | null; bonding: number | null; quality: string | null;
  stackSize: number | null; vendorStack: number | null; purchaseQuantity: number | null;
}

export interface FlipRecipe {
  id: number; name: string; profession: string; productId: number; qtyMin: number; qtyMax: number; learnSkill: number | null;
  spellId: number | null; castMs: number | null; cooldownMs: number | null; cooldownCategory: number | null;
  randomYield: boolean; live: boolean; kind: 'profession' | 'conversion';
  reagents: Array<{ itemId: number; quantity: number }>;
}

/** A vendor an Alliance character can use, its price per unit and the bundle it sells in. */
export interface VendorSource { npcId: number; npcName: string; zone: string | null; places: Place[]; unitPrice: number; bundle: number; limited: boolean; minStanding: number }

export interface TrainerRow { npcId: number; npcName: string; faction: string; zone: string | null; x: number | null; y: number | null; mapId: number | null; spellId: number; name: string; skill: string | null; skillRank: number | null; cost: number | null }

export interface FlipSettings { timeRate: number; goldOnHand: number | null; horizonHours: number }

export interface FlipInputs {
  now: number;
  /** Chip's houses only (chipHouses) */
  houses: HouseRef[];
  /** reasons this run cannot be complete; non empty means runFlips returns no list */
  problems: string[];
  notes: string[];
  /** RAW listings per house then item, buyout only, cheapest first, untrimmed */
  listings: Map<number, Map<number, Listing[]>>;
  items: Map<number, FlipItem>;
  /** usable vendors per item, cheapest first */
  vendors: Map<number, VendorSource[]>;
  recipes: FlipRecipe[];
  demand: Map<number, Map<number, FlipDemand>>;
  typical: Map<number, Map<number, Typical>>;
  /** lowest hourly floor over 3 days per house and item, the fallback when Demand.low3d is missing */
  low3d: Map<number, Map<number, number>>;
  drivers: Map<number, Driver>;
  trainers: TrainerRow[];
  /** "recipe: cerulean dye" style teaching items, by the lower case name they teach */
  recipeItems: Map<string, number>;
  history: { recent: Set<string>; openHours: Map<string, number> };
  settings: FlipSettings;
}

/** Group raw listings by item, buyout only, cheapest first. Nothing is trimmed or judged here. */
export function groupListings(ls: Listing[]): Map<number, Listing[]> {
  const m = new Map<number, Listing[]>();
  for (const l of ls) {
    if (l.unitPrice == null || l.unitPrice <= 0 || l.quantity <= 0) continue;
    let a = m.get(l.itemId);
    if (!a) m.set(l.itemId, (a = []));
    a.push(l);
  }
  for (const a of m.values()) a.sort((x, y) => x.unitPrice! - y.unitPrice! || x.id - y.id);
  return m;
}

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Everything one flip run reads, gathered once. `listingsByHouse` is the collector's current listings per house
 * (both kinds merged, raw). Houses other than Chip's are ignored even when passed.
 */
export function buildFlipInputs(db: DB, listingsByHouse: Map<number, Listing[]>, now = Date.now()): FlipInputs {
  const { houses, notes } = chipHousesWithNotes(db);
  const problems: string[] = [];
  const listings = new Map<number, Map<number, Listing[]>>();
  for (const h of houses) {
    const ls = listingsByHouse.get(h.id);
    if (!ls?.length) { problems.push(`no snapshot for house ${h.id}`); continue; }
    listings.set(h.id, groupListings(ls));
    if (!h.publishedAt) h.publishedAt = now;
  }

  const items = new Map<number, FlipItem>();
  for (const r of db.prepare('SELECT id, name, sell_price, binding, bonding, quality, stack_size, vendor_stack, purchase_quantity FROM items').all() as Array<Record<string, unknown>>) {
    const id = Number(r.id);
    items.set(id, { id, name: (r.name as string | null) ?? `Item ${id}`, sellPrice: num(r.sell_price), binding: (r.binding as string | null) ?? null, bonding: num(r.bonding),
      quality: (r.quality as string | null) ?? null, stackSize: num(r.stack_size), vendorStack: num(r.vendor_stack), purchaseQuantity: num(r.purchase_quantity) });
  }
  if (!items.size) problems.push('item catalog missing');

  const vendors = new Map<number, VendorSource[]>();
  for (const r of db.prepare(`SELECT npc_id, npc_name, zone, x, y, map_id, item_id, price, units_per_purchase, limited, standing_required FROM vendor_items
      WHERE faction IN ('alliance', 'neutral') AND price > 0 AND COALESCE(CAST(standing_required AS INTEGER), 4) <= ?`).all(VENDOR_MAX_STANDING) as Array<Record<string, unknown>>) {
    const itemId = Number(r.item_id);
    const it = items.get(itemId);
    const bundle = Math.max(1, it?.vendorStack ?? num(r.units_per_purchase) ?? 1);
    const v: VendorSource = { npcId: Number(r.npc_id), npcName: String(r.npc_name ?? `NPC ${r.npc_id}`), zone: (r.zone as string | null) ?? null,
      places: [{ label: String(r.npc_name ?? `NPC ${r.npc_id}`), zone: (r.zone as string | null) ?? null, uiMap: num(r.map_id), x: num(r.x), y: num(r.y) }],
      unitPrice: Number(r.price), bundle, limited: !!Number(r.limited), minStanding: num(r.standing_required) ?? 4 };
    let a = vendors.get(itemId);
    if (!a) vendors.set(itemId, (a = []));
    a.push(v);
  }
  for (const a of vendors.values()) a.sort((x, y) => Number(x.limited) - Number(y.limited) || x.unitPrice - y.unitPrice || x.npcId - y.npcId);

  const reagents = new Map<number, Array<{ itemId: number; quantity: number }>>();
  for (const g of db.prepare('SELECT recipe_id, item_id, quantity FROM recipe_reagents').all() as Array<{ recipe_id: number; item_id: number; quantity: number }>) {
    let a = reagents.get(g.recipe_id);
    if (!a) reagents.set(g.recipe_id, (a = []));
    a.push({ itemId: g.item_id, quantity: g.quantity });
  }
  const recipes: FlipRecipe[] = [];
  for (const r of db.prepare('SELECT * FROM recipes WHERE crafted_item_id IS NOT NULL').all() as Array<Record<string, unknown>>) {
    const qtyMin = num(r.qty_min) ?? 1, qtyMax = num(r.qty_max) ?? qtyMin;
    const name = String(r.name ?? `Recipe ${r.id}`), profession = String(r.profession ?? '');
    // Old catalogs have no live or random_yield columns filled: a 1 to N yield range is random, and the
    // test profession rows are not in the game. Both are held back, never ranked.
    const testRow = /\[DNT\]|\(Test\)|^Test /i.test(`${profession} ${name}`);
    recipes.push({ id: Number(r.id), name, profession, productId: Number(r.crafted_item_id), qtyMin, qtyMax, learnSkill: num(r.learn_skill),
      spellId: num(r.spell_id), castMs: num(r.cast_ms), cooldownMs: num(r.cooldown_ms), cooldownCategory: num(r.cooldown_category),
      randomYield: !!Number(r.random_yield ?? 0) || qtyMin !== qtyMax, live: Number(r.live ?? 1) !== 0 && !testRow,
      kind: r.kind === 'conversion' ? 'conversion' : 'profession', reagents: reagents.get(Number(r.id)) ?? [] });
  }
  if (!recipes.length) problems.push('recipe catalog missing');
  if (recipes.length && !recipes.some(r => r.cooldownMs != null)) {
    let n = 0;
    for (const r of recipes) if (TRANSMUTE_FALLBACK.pattern.test(r.name)) { r.cooldownMs = TRANSMUTE_FALLBACK.cooldownMs; r.cooldownCategory = TRANSMUTE_FALLBACK.category; n++; }
    if (n) notes.push(`no recipe has a cooldown on record: ${n} transmutes assumed to share one 24 hour cooldown`);
  }

  const demand = new Map<number, Map<number, FlipDemand>>();
  const typical = new Map<number, Map<number, Typical>>();
  const low3d = new Map<number, Map<number, number>>();
  for (const h of houses) {
    demand.set(h.id, demandByItem(db, h.id, { now }) as Map<number, FlipDemand>);
    typical.set(h.id, typicalFloors(db, h.id, { now, minReadings: UNDERPRICED.minReadings, hours: UNDERPRICED.windowHours }));
    low3d.set(h.id, new Map((db.prepare('SELECT item_id, MIN(floor) f FROM item_stats WHERE house_id = ? AND published_at >= ? AND floor IS NOT NULL GROUP BY item_id')
      .all(h.id, now - 72 * 3600_000) as Array<{ item_id: number; f: number }>).map(r => [r.item_id, r.f])));
  }

  const trainers = (db.prepare(`SELECT npc_id, npc_name, faction, zone, x, y, map_id, spell_id, name, skill, skill_rank, cost FROM trainer_spells`).all() as Array<Record<string, unknown>>)
    .map(r => ({ npcId: Number(r.npc_id), npcName: String(r.npc_name ?? ''), faction: String(r.faction ?? ''), zone: (r.zone as string | null) ?? null, x: num(r.x), y: num(r.y), mapId: num(r.map_id),
      spellId: Number(r.spell_id), name: String(r.name), skill: (r.skill as string | null) ?? null, skillRank: num(r.skill_rank), cost: num(r.cost) }));
  const recipeItems = new Map<string, number>();
  for (const it of items.values()) {
    const m = /^(Recipe|Pattern|Plans|Formula|Schematic|Manual|Design): (.+)$/.exec(it.name);
    if (m && !recipeItems.has(m[2]!.toLowerCase())) recipeItems.set(m[2]!.toLowerCase(), it.id);
  }

  const recent = new Set((db.prepare('SELECT DISTINCT key FROM flip_history WHERE at >= ? AND at < ?').all(now - OPENING.newWindowHours * 3600_000, now) as Array<{ key: string }>).map(r => r.key));
  const openHours = new Map((db.prepare('SELECT key, COUNT(DISTINCT CAST(at / 3600000 AS INTEGER)) n FROM flip_history WHERE at >= ? AND at < ? GROUP BY key')
    .all(now - OPENING.trendHours * 3600_000, now) as Array<{ key: string; n: number }>).map(r => [r.key, r.n]));

  const setting = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const rate = num(setting(TIME_RATE_SETTING));
  const gold = num(setting(GOLD_SETTING));
  return {
    now, houses, problems, notes, listings, items, vendors, recipes, demand, typical, low3d, drivers: demandDrivers(db), trainers, recipeItems,
    history: { recent, openHours },
    settings: { timeRate: rate != null && rate >= 0 ? rate : TIME_RATE_DEFAULT, goldOnHand: gold != null && gold > 0 ? Math.round(gold * 10000) : null, horizonHours: HORIZON_HOURS },
  };
}
