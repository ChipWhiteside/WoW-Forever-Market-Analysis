import type { DB } from '../store/db.ts';
import type { PriceBook } from '../analysis/prices.ts';
import { Crafter, skillUpChance, avgQty, type RecipeRow } from './makeOrBuy.ts';
import { netPerUnit } from '../rules/fees.ts';
import { GUIDES, GUIDE_LEARN, type GuideStep } from './guides/blacksmithing.ts';
import { recipeSources, KNOWN_TRAINERS, type RecipeLearn } from './recipeSources.ts';

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
/** A recipe to learn for this range, in the order the plan first needs it. */
export interface RecipeToLearn extends RecipeLearn { firstAt: number }
/** A profession rank to train (Journeyman, Expert, Artisan) so the skill cap does not stop the plan. */
export interface RankTraining { name: string; learnAt: number; capBefore: number; cost: number | null; where: string }
export interface LevelingPlan { profession: string; from: number; to: number; steps: StepPlan[];
  recipes: RecipeToLearn[]; ranks: RankTraining[];
  /** Alliance usable trainers for this profession, for recipes a trainer teaches */
  trainerPlaces: Array<{ who: string; zone: string; note: string; minRank?: number }>;
  /** trainer and vendor costs for every recipe and rank in range; drops are not counted */
  learnCost: number; needs: Need[]; totalBuyCost: number; sellInstead: SellInstead[]; missing: string[];
  /** true when a step's crafts or a material's price is unknown, so totals are a floor, not the full cost */
  partial: boolean; partialWhy: string[] }

/**
 * Make up to `want` of an item from what is in the bags, through as many crafting steps as needed (ore to bars,
 * bars to bronze, stone to grinding stones), one craft at a time so nothing is half consumed. Mutates `left`.
 */
export function produceFromBags(crafter: Crafter, left: Map<number, number>, itemId: number, want: number, depth: number, consumed?: Map<number, number>): number {
  if (depth > 3 || want <= 0) return 0;
  let made = 0;
  for (const recipe of crafter.recipes.filter(r => r.crafted_item_id === itemId)) {
    // Whole items only: a recipe that makes 1 to 2 counts as 1 here, never 1.5.
    const per = Math.max(1, Math.floor(avgQty(recipe)));
    const ins = crafter.reagentsOf(recipe.id);
    if (!ins.length) continue;
    while (made < want) {
      const snapshot = new Map(left);
      const consumedSnapshot = consumed ? new Map(consumed) : null;
      let ok = true;
      for (const g of ins) {
        const have = left.get(g.item_id) ?? 0;
        const fromHave = Math.min(have, g.quantity);
        left.set(g.item_id, have - fromHave);
        if (fromHave) consumed?.set(g.item_id, (consumed.get(g.item_id) ?? 0) + fromHave);
        const short = g.quantity - fromHave;
        if (short > 0) {
          const got = produceFromBags(crafter, left, g.item_id, short, depth + 1, consumed);
          if (got < short) { ok = false; break; }
          // A craft can make more than needed (one Bronze smelt makes 2 bars): the extra goes back in the bags.
          if (got > short) left.set(g.item_id, (left.get(g.item_id) ?? 0) + got - short);
        }
      }
      if (!ok) {
        left.clear(); for (const [k, v] of snapshot) left.set(k, v);
        if (consumed) { consumed.clear(); for (const [k, v] of consumedSnapshot!) consumed.set(k, v); }
        break;
      }
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
  /** owned units that went into crafting (smelted, ground), as opposed to used as they are */
  const intoCrafts = new Map<number, number>();
  const take = (id: number, n: number) => { const have = left.get(id) ?? 0; const t = Math.min(have, n); left.set(id, have - t); return t; };
  const needs: Need[] = [];
  for (const [itemId, total] of need) {
    let rest = total;
    const fromBags = take(itemId, rest); rest -= fromBags;
    let craftedFromBags = 0;
    if (rest > 0) {
      const made = produceFromBags(crafter, left, itemId, rest, 0, intoCrafts);
      craftedFromBags = Math.min(made, rest);
      if (made > rest) left.set(itemId, (left.get(itemId) ?? 0) + made - rest);
      rest -= craftedFromBags;
    }
    const c = crafter.unitCost(itemId, 1);
    needs.push({ itemId, name: name(itemId), need: total, fromBags, craftedFromBags, buy: rest, unitCost: c.unit, source: c.source === 'none' ? 'no source' : `${c.source}, ${c.detail}`, buyCost: c.unit == null ? null : c.unit * rest });
  }

  // Owned raw materials worth more sold than smelted or ground: sell them, buy the product instead.
  const sellInstead: SellInstead[] = [];
  for (const [itemId] of bags) {
    const used = intoCrafts.get(itemId) ?? 0;
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

  // Recipes to learn, in the order they are first used, and where to get each.
  const recipes: RecipeToLearn[] = [];
  for (const st of steps) {
    if (recipes.some(r => r.recipe.toLowerCase() === st.recipe.toLowerCase())) continue;
    const row = byName.get(st.recipe.toLowerCase());
    recipes.push({ ...recipeSources(db, st.recipe, profession, { learnSkill: row?.learn_skill, guideNote: GUIDE_LEARN[st.recipe] }), firstAt: st.from });
  }
  // Profession ranks: each raises the cap by 75 and is learned 25 points below the old cap.
  const stem = ({ Blacksmithing: 'Blacksmith', Alchemy: 'Alchemist', Tailoring: 'Tailor', Engineering: 'Engineer' } as Record<string, string>)[profession] ?? profession;
  const ranks: RankTraining[] = [];
  const rankRows = db.prepare(`SELECT name, MIN(skill_rank) AS rank, MIN(cost) AS cost FROM trainer_spells WHERE name IN (?, ?, ?) GROUP BY name`)
    .all(`Journeyman ${stem}`, `Expert ${stem}`, `Artisan ${stem}`) as Array<{ name: string; rank: number | null; cost: number | null }>;
  const known = KNOWN_TRAINERS[profession] ?? [];
  const placeList = (artisan: boolean) => known.filter(k => artisan ? k.minRank != null : k.minRank == null).map(k => `${k.who}, ${k.zone}`).join('; ') || `any ${profession} trainer`;
  for (const [title, learnAt] of [['Journeyman', 50], ['Expert', 125], ['Artisan', 200]] as const) {
    const capBefore = learnAt + 25;
    if (from >= capBefore || to <= capBefore) continue; // already past this cap, or the plan stops before it
    const row = rankRows.find(r => r.name === `${title} ${stem}`);
    ranks.push({ name: `${title} ${profession}`, learnAt: row?.rank ?? learnAt, capBefore, cost: row?.cost ?? null,
      where: placeList(title === 'Artisan') });
  }
  const learnCost = recipes.reduce((s, r) => s + (r.cost ?? 0), 0) + ranks.reduce((s, r) => s + (r.cost ?? 0), 0);

  const partialWhy = [
    ...steps.filter(s => s.found && s.crafts == null).map(s => `${s.recipe} (${s.from} to ${s.to}) has no skill up chance in that range, so its crafts are not counted`),
    ...missing.map(m => `${m} is not loaded yet`),
    ...needs.filter(n => n.buy > 0 && n.buyCost == null).map(n => `no price or source for ${n.buy} ${n.name}`),
  ];
  return { profession, from, to, steps, recipes, ranks, learnCost, trainerPlaces: known, needs: needs.sort((x, y) => (y.buyCost ?? 0) - (x.buyCost ?? 0)), totalBuyCost: needs.reduce((s, n) => s + (n.buyCost ?? 0), 0), sellInstead, missing, partial: partialWhy.length > 0, partialWhy };
}
