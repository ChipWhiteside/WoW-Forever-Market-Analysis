import type { DB } from '../store/db.ts';
import type { PriceBook } from '../analysis/prices.ts';
import { Crafter, skillUpChance, avgQty, type RecipeRow } from './makeOrBuy.ts';
import { netPerUnit } from '../rules/fees.ts';
import { GUIDES, type GuideStep } from './guides/blacksmithing.ts';

/**
 * The leveling planner. Walks the guide from the current skill to the target, estimates crafts per step from the
 * recipe colors, and sources every material in this order:
 *   1. what Chip already owns (free),
 *   2. crafted from what he owns (bars from his ore, grinding stones from his stone), also free,
 *   3. bought at the cheapest of the auction house or a vendor.
 * It flags owned materials worth more sold than used: selling them and buying the bar or stone instead is cheaper.
 */
export interface StepPlan {
  from: number; to: number; recipe: string; recipeId: number | null; found: boolean; crafts: number | null;
  colors: { yellow: number | null; green: number | null; grey: number | null }; note?: string;
  reagents: Array<{ itemId: number; name: string; perCraft: number; total: number }>;
  alt?: { recipe: string; crafts: number | null; buyCost: number | null; cheaper: boolean };
  buyCost: number | null;
}
export interface Need { itemId: number; name: string; need: number; fromBags: number; craftedFromBags: number; buy: number; unitCost: number | null; source: string; buyCost: number | null }
export interface SellInstead { itemId: number; name: string; units: number; saleValue: number; replacementCost: number; saves: number; replacement: string }
export interface LevelingPlan { profession: string; from: number; to: number; steps: StepPlan[]; needs: Need[]; totalBuyCost: number; sellInstead: SellInstead[]; missing: string[] }

/**
 * Make up to `want` of an item from what is in the bags, through as many crafting steps as needed (ore to bars,
 * bars to bronze, stone to grinding stones), one craft at a time so nothing is half consumed. Mutates `left`.
 */
export function produceFromBags(crafter: Crafter, left: Map<number, number>, itemId: number, want: number, depth: number): number {
  if (depth > 3 || want <= 0) return 0;
  let made = 0;
  for (const recipe of crafter.recipes.filter(r => r.crafted_item_id === itemId)) {
    const per = avgQty(recipe);
    const ins = crafter.reagentsOf(recipe.id);
    if (!ins.length) continue;
    while (made < want) {
      const snapshot = new Map(left);
      let ok = true;
      for (const g of ins) {
        const have = left.get(g.item_id) ?? 0;
        const fromHave = Math.min(have, g.quantity);
        left.set(g.item_id, have - fromHave);
        const short = g.quantity - fromHave;
        if (short > 0) {
          const got = produceFromBags(crafter, left, g.item_id, short, depth + 1);
          if (got < short) { ok = false; break; }
          // A craft can make more than needed (one Bronze smelt makes 2 bars): the extra goes back in the bags.
          if (got > short) left.set(g.item_id, (left.get(g.item_id) ?? 0) + got - short);
        }
      }
      if (!ok) { left.clear(); for (const [k, v] of snapshot) left.set(k, v); break; }
      made += per;
    }
    if (made >= want) break;
  }
  return made;
}

export function crafts(r: Pick<RecipeRow, 'yellow' | 'grey'>, from: number, to: number): number | null {
  let c = 0;
  for (let s = from; s < to; s++) {
    const ch = skillUpChance(r, s);
    if (ch == null) return null;
    if (ch <= 0) return null;
    c += 1 / ch;
  }
  return Math.ceil(c);
}

export function inventoryOf(db: DB): Map<number, number> {
  return new Map((db.prepare('SELECT item_id, count FROM inventory WHERE count > 0').all() as Array<{ item_id: number; count: number }>).map(r => [r.item_id, r.count]));
}

export function levelingPlan(db: DB, book: PriceBook, profession: string, from: number, to: number, bags = inventoryOf(db)): LevelingPlan {
  const guide: GuideStep[] = GUIDES[profession] ?? [];
  const crafter = new Crafter(db, book);
  const byName = new Map<string, RecipeRow>();
  for (const r of crafter.recipes) if (r.profession === profession) byName.set(r.name.toLowerCase(), r);
  const name = (id: number) => book.names.get(id) ?? `Item ${id}`;
  const missing: string[] = [];
  const need = new Map<number, number>();
  const stepCost = (r: RecipeRow, n: number) => crafter.reagentsOf(r.id).reduce<number | null>((s, g) => { const u = crafter.unitCost(g.item_id, 1).unit; return s == null || u == null ? null : s + u * g.quantity * n; }, 0);

  const steps: StepPlan[] = [];
  for (const g of guide) {
    if (g.to <= from || g.from >= to) continue;
    const a = Math.max(g.from, from), b = Math.min(g.to, to);
    const r = byName.get(g.recipe.toLowerCase());
    if (!r) { missing.push(g.recipe); steps.push({ from: a, to: b, recipe: g.recipe, recipeId: null, found: false, crafts: null, colors: { yellow: null, green: null, grey: null }, note: g.note, reagents: [], buyCost: null }); continue; }
    let use = r, n = crafts(r, a, b);
    let alt: StepPlan['alt'];
    if (g.alt) {
      const ar = byName.get(g.alt.toLowerCase());
      if (ar) {
        const an = crafts(ar, a, b);
        const mainCost = n == null ? null : stepCost(r, n), altCost = an == null ? null : stepCost(ar, an);
        const cheaper = altCost != null && (mainCost == null || altCost < mainCost);
        alt = { recipe: ar.name, crafts: an, buyCost: altCost, cheaper };
        if (cheaper) { use = ar; n = an; }
      }
    }
    const reagents = crafter.reagentsOf(use.id).map(x => ({ itemId: x.item_id, name: name(x.item_id), perCraft: x.quantity, total: n == null ? 0 : x.quantity * n }));
    for (const x of reagents) need.set(x.itemId, (need.get(x.itemId) ?? 0) + x.total);
    steps.push({ from: a, to: b, recipe: use.name, recipeId: use.id, found: true, crafts: n, colors: { yellow: use.yellow, green: use.green, grey: use.grey }, note: g.note, reagents,
      alt: alt && use.name !== g.recipe ? { ...alt, recipe: g.recipe } : alt, buyCost: n == null ? null : stepCost(use, n) });
  }

  // Source each material: bags, then crafted from bags (one level: bars from ore, stones from stone), then buy.
  const left = new Map(bags);
  const take = (id: number, n: number) => { const have = left.get(id) ?? 0; const t = Math.min(have, n); left.set(id, have - t); return t; };
  const needs: Need[] = [];
  for (const [itemId, total] of need) {
    let rest = total;
    const fromBags = take(itemId, rest); rest -= fromBags;
    let craftedFromBags = 0;
    if (rest > 0) {
      const made = produceFromBags(crafter, left, itemId, rest, 0);
      craftedFromBags = Math.min(made, rest);
      if (made > rest) left.set(itemId, (left.get(itemId) ?? 0) + made - rest);
      rest -= craftedFromBags;
    }
    const c = crafter.unitCost(itemId, 1);
    needs.push({ itemId, name: name(itemId), need: total, fromBags, craftedFromBags, buy: rest, unitCost: c.unit, source: c.source === 'none' ? 'no source' : `${c.source}, ${c.detail}`, buyCost: c.unit == null ? null : c.unit * rest });
  }

  // Owned raw materials worth more sold than smelted or ground: sell them, buy the product instead.
  const sellInstead: SellInstead[] = [];
  for (const [itemId, owned] of bags) {
    const used = owned - (left.get(itemId) ?? 0);
    if (used <= 0) continue;
    const f = book.floor.get(itemId);
    if (!f) continue;
    const recipe = crafter.recipes.find(r => crafter.reagentsOf(r.id).some(g => g.item_id === itemId) && need.has(r.crafted_item_id ?? -1));
    if (!recipe || recipe.crafted_item_id == null) continue;
    const product = book.floor.get(recipe.crafted_item_id);
    if (!product) continue;
    const g = crafter.reagentsOf(recipe.id).find(x => x.item_id === itemId)!;
    const productsFromUsed = (used / g.quantity) * avgQty(recipe);
    const saleValue = netPerUnit(book.faction, f.floor) * used;
    const replacementCost = Math.round(product.floor * productsFromUsed);
    if (saleValue > replacementCost * 1.1) {
      sellInstead.push({ itemId, name: name(itemId), units: used, saleValue, replacementCost, saves: saleValue - replacementCost, replacement: `${Math.round(productsFromUsed)} ${name(recipe.crafted_item_id)}` });
    }
  }

  return { profession, from, to, steps, needs: needs.sort((x, y) => (y.buyCost ?? 0) - (x.buyCost ?? 0)), totalBuyCost: needs.reduce((s, n) => s + (n.buyCost ?? 0), 0), sellInstead, missing };
}
