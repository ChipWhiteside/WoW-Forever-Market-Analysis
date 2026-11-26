import type { DB } from '../store/db.ts';
import type { Listing } from '../analysis/aggregate.ts';
import type { Demand, Driver } from '../detectors/types.ts';
import type { Place } from '../datasets/places.ts';
import { demandByItem, typicalFloors, type Typical } from '../analysis/history.ts';
import { demandDrivers } from '../engine/context.ts';
import { UNDERPRICED } from '../rules/thresholds.ts';
import { CRAFT_SESSION_MINUTES_DEFAULT, CRAFT_SESSION_SETTING, FRESH_HOURS, GOLD_SETTING, HORIZON_HOURS, MY_PROFESSIONS_SETTING, OPENING, RISK, TIME_RATE_DEFAULT, TIME_RATE_SETTING, TRANSMUTE_FALLBACK, VENDOR_MAX_STANDING } from '../rules/flips.ts';
import { chipHousesWithNotes } from './houses.ts';
import { newPostsFromRaw, type NewPosts } from './newPosts.ts';
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
  /** sale events (vanished listings judged sold) over the hours watched, and the mean units each one took */
  saleEvents?: number | null;
  unitsPerEvent?: number | null;
  /** hours of differenced publishes behind these numbers */
  hoursWatched?: number | null;
  /** the floor's change since the previous publish, as a share (-0.12 fell 12 percent); new and sold units that hour */
  floorChange1h?: number | null;
  newLastHour?: number | null;
  soldLastHour?: number | null;
  /** mean and standard deviation of units sold an hour over the hours watched, and how many hours (sale counting) */
  hourlyMean?: number | null;
  hourlySd?: number | null;
  hourlyHours?: number | null;
};

export interface FlipItem {
  id: number; name: string; sellPrice: number | null; binding: string | null; bonding: number | null; quality: string | null;
  stackSize: number | null; vendorStack: number | null; purchaseQuantity: number | null;
  /** where name, prices and binding came from: forever | classic1x | wago (items.data_source) */
  dataSource?: string | null;
}

export interface FlipRecipe {
  id: number; name: string; profession: string; productId: number; qtyMin: number; qtyMax: number; learnSkill: number | null;
  spellId: number | null; castMs: number | null; cooldownMs: number | null; cooldownCategory: number | null;
  /** the item that teaches it, linked by id through the game's ItemEffect table (recipes.teach_item_id, migration 12) */
  teachItemId?: number | null;
  /** where learnSkill came from: trainer_alliance | trainer_horde_only | item | auto | yellow (recipes.learn_source) */
  learnSource?: string | null;
  randomYield: boolean; live: boolean; kind: 'profession' | 'conversion';
  reagents: Array<{ itemId: number; quantity: number }>;
}

/** A vendor an Alliance character can use, its price per unit and the bundle it sells in. */
export interface VendorSource { npcId: number; npcName: string; zone: string | null; places: Place[]; unitPrice: number; bundle: number; limited: boolean; minStanding: number }

export interface TrainerRow { npcId: number; npcName: string; faction: string; zone: string | null; x: number | null; y: number | null; mapId: number | null; spellId: number | null; name: string; skill: string | null; skillRank: number | null; cost: number | null }

export interface FlipSettings {
  timeRate: number; goldOnHand: number | null; horizonHours: number;
  /** minutes of casting one crafting session allows; the best quantity of a craft stays inside it */
  craftSessionMinutes?: number;
  /**
   * The professions Chip has, with his skill when he gave one (settings key my_professions, JSON: ["Tailoring"] or
   * {"Tailoring": 300}). Unset (null): every sub craft is allowed and only listed.
   */
  myProfessions?: Map<string, number | null> | null;
}

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
  /** new listings by price per house from the raw publishes (newPosts.ts); absent when raw snapshots are not on disk */
  newPosts?: Map<number, NewPosts>;
  /** hours of floors behind low3d per house and item (the item's first floor ever recorded to now) */
  low3dHours?: Map<number, Map<number, number>>;
  drivers: Map<number, Driver>;
  trainers: TrainerRow[];
  /** teaching items ("Recipe: Cerulean Dye", "Blueprint: Tanning Rack") by the normalized name they teach (recipeKey);
   * only a fallback for recipes whose teach_item_id is not filled */
  recipeItems: Map<string, number>;
  /** teaching items with a loot record (a creature or object drops them); absent in fixtures means none */
  lootItems?: Set<number>;
  /** recent: keys seen within the last publish gap; openHours: distinct earlier hours open in the last 72, this hour not counted */
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

/** Teaching item prefixes in the game (Recipe:, Pattern:, Plans:, Formula:, Schematic:, Blueprint:, Manual:, Design:). */
export const TEACH_PREFIX = /^(Recipe|Pattern|Plans|Formula|Schematic|Blueprint|Manual|Design): (.+)$/;
/** A recipe or teaching item name reduced to letters and digits: "Transmute: Life to Earth" and "Transmute Life to Earth" agree. */
export const recipeKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A vendor's exact price per unit: what it charges for one purchase (price_by_standing at Friendly or lower, the most
 * Chip pays) divided by the units in that purchase. Rough Arrow: 10c for 200 is 0.05c each; Shiny Red Apple 25c for 5.
 * Falls back to the stored per unit price when no standing price is recorded.
 */
export function vendorUnitPrice(priceByStanding: string | null, unitsPerPurchase: number | null, fallback: number): number {
  try {
    const costs = JSON.parse(priceByStanding ?? '{}') as Record<string, number>;
    const usable = Object.entries(costs).filter(([st, c]) => Number(st) <= VENDOR_MAX_STANDING && c > 0).map(([, c]) => c);
    if (usable.length && unitsPerPurchase && unitsPerPurchase > 0) return Math.max(...usable) / unitsPerPurchase;
  } catch { /* fall through */ }
  return fallback;
}

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Everything one flip run reads, gathered once. `listingsByHouse` is the collector's current listings per house
 * (both kinds merged, raw). Houses other than Chip's are ignored even when passed. `missing` names listings the caller
 * could not read (a raw file gone): each makes the run incomplete, never a silent partial list (round 1 finding L5).
 */
export function buildFlipInputs(db: DB, listingsByHouse: Map<number, Listing[]>, now = Date.now(), missing: string[] = []): FlipInputs {
  const { houses, notes } = chipHousesWithNotes(db);
  const problems: string[] = [...missing];
  const listings = new Map<number, Map<number, Listing[]>>();
  for (const h of houses) {
    const ls = listingsByHouse.get(h.id);
    if (!ls?.length) { problems.push(`no snapshot for house ${h.id}`); continue; }
    listings.set(h.id, groupListings(ls));
    // Both listing kinds must be there and fresh (round 1 findings M1 and L5), never a silent partial list.
    const kinds = new Map((db.prepare('SELECT kind, MAX(published_at) t FROM snapshots WHERE house_id = ? AND published_at <= ? GROUP BY kind').all(h.id, now) as Array<{ kind: string; t: number }>).map(r => [r.kind, r.t]));
    for (const k of ['auctions', 'commodities']) if (!kinds.has(k)) problems.push(`house ${h.id} has no ${k} snapshot`);
    const newest = Math.max(0, ...kinds.values());
    if (newest) {
      h.publishedAt = newest;
      const age = (now - newest) / 3600_000;
      // rounded up, so a run just past the gate never reads "2 hours old" (round 2 finding L3)
      if (age > FRESH_HOURS) problems.push(`data is ${Math.ceil(age * 10) / 10} hours old on house ${h.id}`);
    }
    if (!h.publishedAt) h.publishedAt = now;
  }

  const items = new Map<number, FlipItem>();
  for (const r of db.prepare('SELECT id, name, sell_price, binding, bonding, quality, stack_size, vendor_stack, purchase_quantity, data_source FROM items').all() as Array<Record<string, unknown>>) {
    const id = Number(r.id);
    items.set(id, { id, name: (r.name as string | null) ?? `Item ${id}`, sellPrice: num(r.sell_price), binding: (r.binding as string | null) ?? null, bonding: num(r.bonding),
      quality: (r.quality as string | null) ?? null, stackSize: num(r.stack_size), vendorStack: num(r.vendor_stack), purchaseQuantity: num(r.purchase_quantity),
      dataSource: (r.data_source as string | null) ?? null });
  }
  if (!items.size) problems.push('item catalog missing');

  const vendors = new Map<number, VendorSource[]>();
  for (const r of db.prepare(`SELECT npc_id, npc_name, zone, x, y, map_id, item_id, price, price_by_standing, units_per_purchase, limited, standing_required FROM vendor_items
      WHERE faction IN ('alliance', 'neutral') AND price > 0 AND COALESCE(CAST(standing_required AS INTEGER), 4) <= ?`).all(VENDOR_MAX_STANDING) as Array<Record<string, unknown>>) {
    const itemId = Number(r.item_id);
    const it = items.get(itemId);
    const upp = num(r.units_per_purchase);
    const bundle = Math.max(1, upp ?? it?.vendorStack ?? 1);
    const v: VendorSource = { npcId: Number(r.npc_id), npcName: String(r.npc_name ?? `NPC ${r.npc_id}`), zone: (r.zone as string | null) ?? null,
      places: [{ label: String(r.npc_name ?? `NPC ${r.npc_id}`), zone: (r.zone as string | null) ?? null, uiMap: num(r.map_id), x: num(r.x), y: num(r.y) }],
      unitPrice: vendorUnitPrice((r.price_by_standing as string | null) ?? null, upp, Number(r.price)), bundle, limited: !!Number(r.limited), minStanding: num(r.standing_required) ?? 4 };
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
      kind: r.kind === 'conversion' ? 'conversion' : 'profession', reagents: reagents.get(Number(r.id)) ?? [],
      teachItemId: num(r.teach_item_id), learnSource: (r.learn_source as string | null | undefined) ?? null });
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
  const low3dHours = new Map<number, Map<number, number>>();
  const newPosts = new Map<number, NewPosts>();
  for (const h of houses) {
    const np = newPostsFromRaw(db, h.id, now);
    if (np) newPosts.set(h.id, np);
    demand.set(h.id, enrichDemand(db, h.id, now, demandByItem(db, h.id, { now }) as Map<number, FlipDemand>));
    typical.set(h.id, typicalFloors(db, h.id, { now, minReadings: UNDERPRICED.minReadings, hours: UNDERPRICED.windowHours }));
    // The 3 day low and how many hours of floors stand behind it (round 1 finding H3: under 72, a 25 percent drop is assumed).
    // Coverage counts from the item's first floor ever recorded, so a reading older than the window proves 72 hours.
    const lows = db.prepare('SELECT item_id, MIN(CASE WHEN published_at >= ? THEN floor END) f, MIN(published_at) first FROM item_stats WHERE house_id = ? AND published_at <= ? AND floor IS NOT NULL GROUP BY item_id')
      .all(now - RISK.lowCoverHours * 3600_000, h.id, now) as Array<{ item_id: number; f: number | null; first: number }>;
    low3d.set(h.id, new Map(lows.filter(r => r.f != null).map(r => [r.item_id, r.f!])));
    low3dHours.set(h.id, new Map(lows.map(r => [r.item_id, (now - r.first) / 3600_000])));
  }

  const trainers = (db.prepare(`SELECT npc_id, npc_name, faction, zone, x, y, map_id, spell_id, name, skill, skill_rank, cost FROM trainer_spells`).all() as Array<Record<string, unknown>>)
    .map(r => ({ npcId: Number(r.npc_id), npcName: String(r.npc_name ?? ''), faction: String(r.faction ?? ''), zone: (r.zone as string | null) ?? null, x: num(r.x), y: num(r.y), mapId: num(r.map_id),
      spellId: num(r.spell_id), name: String(r.name), skill: (r.skill as string | null) ?? null, skillRank: num(r.skill_rank), cost: num(r.cost) }));
  // Teaching items by name, any prefix, lowest id first so the pick never depends on table order.
  const recipeItems = new Map<string, number>();
  for (const it of [...items.values()].sort((a, b) => a.id - b.id)) {
    const m = TEACH_PREFIX.exec(it.name);
    if (m && !recipeItems.has(recipeKey(m[2]!))) recipeItems.set(recipeKey(m[2]!), it.id);
  }
  // Teaching items something drops (round 6 finding 2): a recipe item with no vendor, no listing and no drop has no known source.
  const teach = new Set<number>([...recipeItems.values(), ...recipes.map(r => r.teachItemId).filter((x): x is number => x != null)]);
  const lootItems = new Set((db.prepare('SELECT DISTINCT item_id FROM loot').all() as Array<{ item_id: number }>).map(r => r.item_id).filter(id => teach.has(id)));

  const recent = new Set((db.prepare('SELECT DISTINCT key FROM flip_history WHERE at >= ? AND at < ?').all(now - OPENING.newWindowHours * 3600_000, now) as Array<{ key: string }>).map(r => r.key));
  // Distinct earlier clock hours only, the 71 before this one: two runs in one hour count once, and this hour is added
  // by the run itself, so "open N of the last 72 hours" never double counts and never passes 72 (round 1 finding L3).
  const thisHour = Math.floor(now / 3600_000);
  const openHours = new Map((db.prepare('SELECT key, COUNT(DISTINCT CAST(at / 3600000 AS INTEGER)) n FROM flip_history WHERE CAST(at / 3600000 AS INTEGER) >= ? AND CAST(at / 3600000 AS INTEGER) < ? AND at < ? GROUP BY key')
    .all(thisHour - (OPENING.trendHours - 1), thisHour, now) as Array<{ key: string; n: number }>).map(r => [r.key, r.n]));

  const setting = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const rate = num(setting(TIME_RATE_SETTING));
  const gold = num(setting(GOLD_SETTING));
  const session = num(setting(CRAFT_SESSION_SETTING));
  return {
    now, houses, problems, notes, listings, items, vendors, recipes, demand, typical, low3d, low3dHours, newPosts, drivers: demandDrivers(db), trainers, recipeItems, lootItems,
    history: { recent, openHours },
    settings: { timeRate: rate != null && rate >= 0 ? rate : TIME_RATE_DEFAULT, goldOnHand: gold != null && gold > 0 ? Math.round(gold * 10000) : null, horizonHours: HORIZON_HOURS,
      craftSessionMinutes: session != null && session > 0 ? session : CRAFT_SESSION_MINUTES_DEFAULT, myProfessions: parseProfessions(setting(MY_PROFESSIONS_SETTING), notes) },
  };
}

/** my_professions: a JSON list of names or an object of name to skill. Anything else is ignored and noted. */
export function parseProfessions(raw: string | undefined, notes: string[] = []): Map<string, number | null> | null {
  if (raw == null || raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return new Map(v.filter(x => typeof x === 'string').map(x => [x as string, null]));
    if (v && typeof v === 'object') return new Map(Object.entries(v as Record<string, unknown>).map(([k, n]) => [k, typeof n === 'number' && Number.isFinite(n) ? n : null]));
  } catch { /* noted below */ }
  notes.push(`setting ${MY_PROFESSIONS_SETTING} is not a JSON list or object, ignored`);
  return null;
}

/**
 * Fill in what sale counting does not give, from the stored hourly counts (never guessed): sale events and units per
 * event (vanished listings), new units posted near the floor (new_near_floor, else every new unit), units pulled near
 * the floor, and what happened in the last hour (floor change, new and sold units) for the price war check.
 * Sale counting's own fields (src/analysis/history.ts demandByItem) are authoritative: a field already present is
 * never overwritten; the derivation here is only the fallback for a Demand that lacks it.
 */
export function enrichDemand(db: DB, houseId: number, now: number, demand: Map<number, FlipDemand>): Map<number, FlipDemand> {
  const since = now - 72 * 3600_000;
  // Per publish: units judged sold (the same rule as demandByItem), and the sale events behind them, which are the
  // vanished listings scaled by the share of vanished units judged sold (gone listings minus the expiring and far from
  // the floor share). New units near the floor where measured, else every new unit (older rows).
  const SOLD = 'COALESCE(sold_units, MAX(0, COALESCE(gone_units_near_floor, 0) - COALESCE(gone_units_expiring_near_floor, 0)))';
  const rows = db.prepare(`SELECT item_id, SUM(${SOLD}) sold,
      SUM(CASE WHEN COALESCE(gone_units, 0) > 0 THEN COALESCE(gone_listings, 0) * 1.0 * ${SOLD} / gone_units ELSE 0 END) events,
      SUM(COALESCE(new_near_floor, new_units, 0)) fresh, SUM(COALESCE(gone_units_expiring_near_floor, 0)) pulled
    FROM item_stats WHERE house_id = ? AND published_at >= ? AND published_at <= ? AND gone_units IS NOT NULL AND sold_value IS NOT NULL GROUP BY item_id`)
    .all(houseId, since, now) as Array<{ item_id: number; sold: number; events: number; fresh: number; pulled: number }>;
  for (const r of rows) {
    const d = demand.get(r.item_id);
    if (!d) continue;
    const hours = d.hoursWatched ?? d.hours;
    if (d.saleEvents == null) d.saleEvents = r.events;
    if (d.unitsPerEvent == null) d.unitsPerEvent = r.events > 0 ? Math.max(1, r.sold / r.events) : null;
    if (d.hoursWatched == null) d.hoursWatched = hours;
    if (d.newPerDay == null && hours > 0) d.newPerDay = (r.fresh / hours) * 24;
    if (d.pulledPerDay == null && hours > 0) d.pulledPerDay = (r.pulled / hours) * 24;
  }
  // The last hour: the newest differenced publish of each kind, against the one before it.
  const last = db.prepare(`SELECT s.id, s.kind, s.published_at t FROM snapshots s WHERE s.house_id = ? AND s.published_at <= ? AND s.diff_hours IS NOT NULL
      AND s.published_at = (SELECT MAX(published_at) FROM snapshots x WHERE x.house_id = s.house_id AND x.kind = s.kind AND x.published_at <= ?)`).all(houseId, now, now) as Array<{ id: number; kind: string; t: number }>;
  for (const l of last) {
    const prev = db.prepare('SELECT id FROM snapshots WHERE house_id = ? AND kind = ? AND published_at < ? ORDER BY published_at DESC LIMIT 1').get(houseId, l.kind, l.t) as { id: number } | undefined;
    if (!prev) continue;
    const before = new Map((db.prepare('SELECT item_id, floor FROM item_stats WHERE snapshot_id = ? AND floor IS NOT NULL').all(prev.id) as Array<{ item_id: number; floor: number }>).map(r => [r.item_id, r.floor]));
    for (const r of db.prepare(`SELECT item_id, floor, COALESCE(new_near_floor, new_units) nw, MAX(0, COALESCE(gone_units_near_floor, 0) - COALESCE(gone_units_expiring_near_floor, 0)) sold
        FROM item_stats WHERE snapshot_id = ?`).all(l.id) as Array<{ item_id: number; floor: number | null; nw: number | null; sold: number }>) {
      const d = demand.get(r.item_id);
      if (!d) continue;
      const b = before.get(r.item_id);
      if (d.floorChange1h == null && b && r.floor != null) d.floorChange1h = (r.floor - b) / b;
      if (d.newLastHour == null && r.nw != null) d.newLastHour = r.nw;
      if (d.soldLastHour == null) d.soldLastHour = r.sold;
    }
  }
  return demand;
}
