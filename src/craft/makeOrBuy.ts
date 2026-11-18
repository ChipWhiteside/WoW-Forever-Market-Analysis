import type { DB } from '../store/db.ts';
import type { PriceBook } from '../analysis/prices.ts';
import { netPerUnit } from '../rules/fees.ts';

/**
 * O4 Make or buy. Every product breaks into ingredients, every craftable ingredient breaks again, down to raw
 * materials. At each node the cheapest of: buy on the auction house, buy from an Alliance usable vendor,
 * craft it. Materials Chip gathers himself are valued by default at what he could sell them for, which is the
 * auction floor, so "buy" and "use your own" cost the same unless he changes that setting.
 */
export type Source = 'auction' | 'vendor' | 'craft' | 'none';

export interface Node {
  itemId: number; name: string; quantity: number; unitCost: number | null; total: number | null;
  source: Source; detail: string; children?: Node[]; alternatives: Array<{ source: Source; unitCost: number }>;
}

export interface RecipeRow { id: number; name: string; profession: string; crafted_item_id: number | null; qty_min: number; qty_max: number; learn_skill: number | null; yellow: number | null; green: number | null; grey: number | null }

export class Crafter {
  private recipesByProduct = new Map<number, RecipeRow[]>();
  private reagents = new Map<number, Array<{ item_id: number; quantity: number }>>();
  private memo = new Map<number, { unit: number | null; source: Source; detail: string; recipe?: RecipeRow }>();

  constructor(db: DB, private book: PriceBook, private knownProfessions: Record<string, number> | null = null) {
    for (const r of db.prepare('SELECT * FROM recipes WHERE crafted_item_id IS NOT NULL').all() as unknown as RecipeRow[]) {
      const a = this.recipesByProduct.get(r.crafted_item_id!) ?? [];
      a.push(r); this.recipesByProduct.set(r.crafted_item_id!, a);
    }
    for (const g of db.prepare('SELECT recipe_id, item_id, quantity FROM recipe_reagents').all() as Array<{ recipe_id: number; item_id: number; quantity: number }>) {
      const a = this.reagents.get(g.recipe_id) ?? [];
      a.push({ item_id: g.item_id, quantity: g.quantity }); this.reagents.set(g.recipe_id, a);
    }
  }

  get recipes(): RecipeRow[] { return [...this.recipesByProduct.values()].flat(); }
  reagentsOf(recipeId: number) { return this.reagents.get(recipeId) ?? []; }

  canCraft(r: RecipeRow): boolean {
    if (!this.knownProfessions) return true;
    const skill = this.knownProfessions[r.profession];
    return skill != null && skill >= (r.learn_skill ?? r.yellow ?? 1);
  }

  /** Cheapest unit cost of an item, choosing among auction, vendor and crafting. Cycles and depth are guarded. */
  unitCost(itemId: number, depth = 0, stack: Set<number> = new Set()): { unit: number | null; source: Source; detail: string; recipe?: RecipeRow } {
    const m = this.memo.get(itemId);
    if (m && depth > 0) return m;
    const options: Array<{ unit: number; source: Source; detail: string; recipe?: RecipeRow }> = [];
    const ah = this.book.floor.get(itemId);
    if (ah) options.push({ unit: ah.floor, source: 'auction', detail: `${this.book.houseName} floor` });
    const v = this.book.vendor.get(itemId);
    if (v) options.push({ unit: v.price, source: 'vendor', detail: `${v.npc}${v.zone ? `, ${v.zone}` : ''}` });
    // Only cache an answer that did not depend on where we were in the tree (review finding 9).
    let pathDependent = depth >= 4 || stack.has(itemId);
    if (depth < 4 && !stack.has(itemId)) {
      stack.add(itemId);
      for (const r of this.recipesByProduct.get(itemId) ?? []) {
        if (!this.canCraft(r)) continue;
        if (this.reagentsOf(r.id).some(g => stack.has(g.item_id))) pathDependent = true;
        const c = this.craftCost(r, depth + 1, stack);
        if (c != null) options.push({ unit: Math.ceil(c / Math.max(1, avgQty(r))), source: 'craft', detail: r.name, recipe: r });
      }
      stack.delete(itemId);
    }
    const best = options.sort((a, b) => a.unit - b.unit)[0];
    const res = best ?? { unit: null, source: 'none' as const, detail: 'no source, path blocked' };
    if (depth > 0 && !pathDependent) this.memo.set(itemId, res);
    return res;
  }

  craftCost(r: RecipeRow, depth = 1, stack: Set<number> = new Set()): number | null {
    let total = 0;
    for (const g of this.reagentsOf(r.id)) {
      const c = this.unitCost(g.item_id, depth, stack);
      if (c.unit == null) return null;
      total += c.unit * g.quantity;
    }
    return total;
  }

  /** The full tree for one recipe with the choice made at each node. */
  tree(r: RecipeRow, depth = 1, stack: Set<number> = new Set([r.crafted_item_id ?? -1])): Node[] {
    return this.reagentsOf(r.id).map(g => {
      const best = this.unitCost(g.item_id, depth, stack);
      const alts: Array<{ source: Source; unitCost: number }> = [];
      const ah = this.book.floor.get(g.item_id); if (ah) alts.push({ source: 'auction', unitCost: ah.floor });
      const v = this.book.vendor.get(g.item_id); if (v) alts.push({ source: 'vendor', unitCost: v.price });
      const node: Node = {
        itemId: g.item_id, name: this.book.names.get(g.item_id) ?? `Item ${g.item_id}`, quantity: g.quantity,
        unitCost: best.unit, total: best.unit == null ? null : best.unit * g.quantity, source: best.source, detail: best.detail, alternatives: alts,
      };
      if (best.source === 'craft' && best.recipe && depth < 4 && !stack.has(g.item_id)) {
        stack.add(g.item_id); node.children = this.tree(best.recipe, depth + 1, stack); stack.delete(g.item_id);
      }
      return node;
    });
  }
}

export const avgQty = (r: Pick<RecipeRow, 'qty_min' | 'qty_max'>) => ((r.qty_min || 1) + (r.qty_max || r.qty_min || 1)) / 2;

/** Classic skill up odds: certain below yellow, then falling linearly to zero at grey. Approximate. */
export function skillUpChance(r: Pick<RecipeRow, 'yellow' | 'grey'>, skill: number): number | null {
  if (r.yellow == null || r.grey == null) return null;
  if (skill < r.yellow) return 1;
  if (skill >= r.grey) return 0;
  return (r.grey - skill) / (r.grey - r.yellow);
}

export interface CraftRow {
  recipeId: number; name: string; profession: string; productId: number; productName: string; cost: number | null; sale: number | null;
  margin: number | null; marginPct: number | null; productFloor: number | null; productUnits: number; blocked: string | null; bop: boolean;
  thresholds: { learn: number | null; yellow: number | null; green: number | null; grey: number | null }; canCraft: boolean;
  sources: string; skillUp: number | null; costPerPoint: number | null;
}

export function craftBoard(db: DB, book: PriceBook, opts: { professions?: Record<string, number> | null; profession?: string } = {}): CraftRow[] {
  const c = new Crafter(db, book, null);
  const out: CraftRow[] = [];
  for (const r of c.recipes) {
    if (opts.profession && r.profession !== opts.profession) continue;
    const pid = r.crafted_item_id!;
    const cost = c.craftCost(r);
    const nodes = c.tree(r);
    const blockedNode = nodes.find(n => n.source === 'none');
    const pf = book.floor.get(pid);
    const bop = book.binding.get(pid) === 'ON_ACQUIRE';
    const qty = avgQty(r);
    // A bind on pickup product is never a sale (spec 5, O4 gates). Its value is the vendor price only.
    const unitSale = bop ? (book.sell.get(pid) ?? null) : pf ? Math.max(netPerUnit(book.faction, pf.floor, book.sell.get(pid)), book.sell.get(pid) ?? 0) : book.sell.get(pid) ?? null;
    const sale = unitSale == null ? null : Math.floor(unitSale * qty);
    const margin = cost != null && sale != null ? sale - cost : null;
    const skill = opts.professions?.[r.profession];
    const chance = skill != null ? skillUpChance(r, skill) : null;
    out.push({
      recipeId: r.id, name: r.name, profession: r.profession, productId: pid, productName: book.names.get(pid) ?? `Item ${pid}`,
      cost, sale, margin, marginPct: margin != null && cost ? margin / cost : null, productFloor: pf?.floor ?? null, productUnits: pf?.units ?? 0,
      blocked: blockedNode ? `no source for ${blockedNode.name}` : null, bop,
      thresholds: { learn: r.learn_skill, yellow: r.yellow, green: r.green, grey: r.grey },
      canCraft: skill != null ? skill >= (r.learn_skill ?? r.yellow ?? 1) : false,
      sources: nodes.map(n => `${n.quantity}x ${n.name} (${n.source})`).join(', '),
      skillUp: chance, costPerPoint: chance && margin != null && margin < 0 ? Math.round(-margin / chance) : null,
    });
  }
  return out.sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
}
