import type { Listing } from '../analysis/aggregate.ts';
import { CRAFT_SESSION_MINUTES_DEFAULT, MAX_CRAFT_DEPTH, VENDOR_LIMITED_BUNDLES } from '../rules/flips.ts';

/**
 * Crafts a cooldown allows inside one crafting session (round 2 finding M2): one now, then one each time it comes
 * back within the session, 1 + floor(session / cooldown). Recipes sharing a cooldown category share the count.
 */
export function cooldownCrafts(r: Pick<FlipRecipe, 'cooldownMs'>, sessionMinutes: number): number {
  if (!r.cooldownMs || r.cooldownMs <= 0) return Infinity;
  return 1 + Math.floor((sessionMinutes * 60_000) / r.cooldownMs);
}
import type { FlipInputs, FlipRecipe, VendorSource } from './inputs.ts';
import type { CostCurve, CurveStep } from './types.ts';

/**
 * The cost book: what the next unit of an item costs to get, cheapest first, as a market Chip buys from.
 *
 * - Auction: the RAW listings on Chip's houses, untrimmed. Troll and junk checks never apply here: if it is listed,
 *   it can be bought. Buying walks the ladder, so the 200th unit costs what the 200th listed unit asks.
 * - Vendor: a flat price per unit, sold in bundles (vials come 5 at a time), limited stock capped.
 * - Craft: the k th craft costs its reagents at their next units, recursively, each reagent again the cheapest of
 *   auction, vendor or craft. Cycles are guarded and the depth is capped.
 *
 * The market is stateful: every unit taken is gone for the next take. So within one recipe tree a shared sub
 * reagent (Copper Bar used directly and inside Bronze Bar) never gets the same cheap listings twice, and the shared
 * pass reuses the same mechanism across flips. Every change is journaled so a candidate can be priced and rolled back.
 */
export type Source = 'auction' | 'vendor' | 'craft';

export interface TraceEntry {
  itemId: number; source: Source;
  /** units bought or made by this step (a vendor bundle, a craft's yield, one auction unit) */
  units: number;
  /** total copper paid for this step */
  cost: number;
  depth: number;
  houseId?: number; listingId?: number; vendor?: VendorSource; recipeId?: number;
  /** copper of `cost` that is the cooldown's opportunity cost, not gold paid (a sub craft on a cooldown) */
  opportunity?: number;
}

export interface TakeMode {
  /** houses whose listings may be bought */
  houses: number[];
  vendor: boolean;
  craft: boolean;
}

interface Spare { units: number; unitCost: number }

export class Market {
  private pos = new Map<string, [number, number]>(); // house:item -> [listing index, units used of it]
  private vendorBought = new Map<string, number>();  // npc:item -> units bought (limited stock)
  private spare = new Map<number, Spare>();          // paid for but unused: rest of a vendor bundle, extra craft yield
  private cdUsed = new Map<string, number>();
  private journal: Array<() => void> = [];
  /** copper paid for spare units not used yet */
  waste = 0;
  readonly byProduct = new Map<number, FlipRecipe[]>();
  private lbMemo = new Map<number, { v: number; need: number }>();
  private lbRoot = new Map<number, number>();
  /**
   * What one unit of an item nets on Chip's auction houses when it is listed (the cautious net of its sell quote), or
   * null. A sub craft on a cooldown costs at least this: spending the cooldown gives up selling its product (system
   * review round 1, finding J3: Cured Rugged Hide burned the Salt Shaker for 1s 47c while the salt nets about 35g).
   */
  opportunityOf: ((itemId: number) => number | null) | null = null;
  private oppMemo = new Map<number, number>();

  constructor(readonly inputs: FlipInputs, private sourceRecipes: FlipRecipe[]) {
    for (const r of sourceRecipes) {
      const a = this.byProduct.get(r.productId) ?? [];
      a.push(r); this.byProduct.set(r.productId, a);
    }
  }

  mark(): number { return this.journal.length; }
  rollback(m: number): void { while (this.journal.length > m) this.journal.pop()!(); }

  private put<K, V>(map: Map<K, V>, k: K, v: V): void {
    const had = map.has(k), old = map.get(k);
    map.set(k, v);
    this.journal.push(() => { if (had) map.set(k, old as V); else map.delete(k); });
  }
  private addWaste(d: number): void { this.waste += d; this.journal.push(() => { this.waste -= d; }); }
  push(trace: TraceEntry[] | null, e: TraceEntry): void {
    if (!trace) return;
    trace.push(e);
    this.journal.push(() => { trace.pop(); });
  }

  ladder(houseId: number, itemId: number): Listing[] { return this.inputs.listings.get(houseId)?.get(itemId) ?? []; }

  /** Next auction unit on one house: its price and listing, or null when the ladder is used up. */
  peekAuction(houseId: number, itemId: number): { price: number; listing: Listing } | null {
    const ls = this.ladder(houseId, itemId);
    const [i, used] = this.pos.get(`${houseId}:${itemId}`) ?? [0, 0];
    let j = i, u = used;
    while (j < ls.length && u >= ls[j]!.quantity) { j++; u = 0; }
    const l = ls[j];
    return l ? { price: l.unitPrice!, listing: l } : null;
  }
  private advanceAuction(houseId: number, itemId: number): void {
    const ls = this.ladder(houseId, itemId);
    const k = `${houseId}:${itemId}`;
    let [i, used] = this.pos.get(k) ?? [0, 0];
    while (i < ls.length && used >= ls[i]!.quantity) { i++; used = 0; }
    this.put(this.pos, k, [i, used + 1] as [number, number]);
  }
  /** Units left on an item's ladder on one house. */
  auctionLeft(houseId: number, itemId: number): number {
    const ls = this.ladder(houseId, itemId);
    const [i, used] = this.pos.get(`${houseId}:${itemId}`) ?? [0, 0];
    let n = -used;
    for (let j = i; j < ls.length; j++) n += ls[j]!.quantity;
    return Math.max(0, n);
  }

  private vendorFor(itemId: number): VendorSource | null {
    for (const v of this.inputs.vendors.get(itemId) ?? []) {
      if (v.limited && (this.vendorBought.get(`${v.npcId}:${itemId}`) ?? 0) + v.bundle > v.bundle * VENDOR_LIMITED_BUNDLES) continue;
      return v; // offers are sorted unlimited first, then cheapest; the cheapest unlimited one wins
    }
    return null;
  }
  private cheapestVendor(itemId: number): VendorSource | null {
    let best: VendorSource | null = null;
    for (const v of this.inputs.vendors.get(itemId) ?? []) {
      if (v.limited && (this.vendorBought.get(`${v.npcId}:${itemId}`) ?? 0) + v.bundle > v.bundle * VENDOR_LIMITED_BUNDLES) continue;
      if (!best || v.unitPrice < best.unitPrice) best = v;
    }
    return best ?? this.vendorFor(itemId);
  }

  /** Whether Chip can make this sub craft himself (settings.myProfessions; unset allows every craft). */
  canCraft(r: FlipRecipe): boolean {
    const mine = this.inputs.settings.myProfessions;
    if (!mine) return true;
    if (!mine.has(r.profession)) return false;
    const skill = mine.get(r.profession);
    return skill == null || r.learnSkill == null || r.learnSkill <= skill;
  }
  yieldOf(r: FlipRecipe): number { return Math.max(1, r.qtyMin || 1); }
  cooldownKey(r: FlipRecipe): string | null {
    if (!r.cooldownMs || r.cooldownMs <= 0) return null;
    return r.cooldownCategory ? `cat:${r.cooldownCategory}` : `rec:${r.id}`;
  }
  /** Crafts a cooldown allows within one crafting session (cooldownCrafts). */
  cooldownCap(r: FlipRecipe): number {
    return cooldownCrafts(r, this.inputs.settings.craftSessionMinutes ?? CRAFT_SESSION_MINUTES_DEFAULT);
  }
  /** The least one unit of a cooldown sub craft's product costs: its own auction net when listed, else 0. */
  cooldownFloor(r: FlipRecipe): number {
    if (!this.cooldownKey(r) || !this.opportunityOf) return 0;
    let v = this.oppMemo.get(r.productId);
    if (v == null) { v = Math.max(0, this.opportunityOf(r.productId) ?? 0); this.oppMemo.set(r.productId, v); }
    return v;
  }
  cooldownLeft(r: FlipRecipe): number {
    const k = this.cooldownKey(r);
    return k ? this.cooldownCap(r) - (this.cdUsed.get(k) ?? 0) : Infinity;
  }

  /**
   * Static lower bound on one unit's cost (cheapest listing anywhere on Chip's houses, vendor, or the bound of a
   * craft). Only used to skip pricing a craft that cannot win; never a price shown to Chip.
   *
   * The answer must never depend on which item was asked about first (round 1 finding M2). A value worked out under a
   * depth cut or a recipe cycle depends on the path that reached it, so it is never reused elsewhere. `lbMemo` keeps
   * only exact values (no cut anywhere below) with the recipe depth they needed, and a hit is used only where that
   * depth still fits under MAX_CRAFT_DEPTH, so a hit always equals what working it out again would give. An item's own
   * top level value (asked with nothing above it) goes in `lbRoot`, read only by top level questions.
   */
  lowerBound(itemId: number, stack: Set<number> = new Set(), depth = 0): number {
    return this.lb(itemId, stack, depth).v;
  }
  private lb(itemId: number, stack: Set<number>, depth: number): { v: number; cut: boolean; need: number } {
    const exact = this.lbMemo.get(itemId);
    if (exact && depth + exact.need <= MAX_CRAFT_DEPTH) return { v: exact.v, cut: false, need: exact.need };
    const top = depth === 0 && stack.size === 0;
    if (top) { const r = this.lbRoot.get(itemId); if (r != null) return { v: r, cut: true, need: 0 }; }
    let best = Infinity, cut = false, need = 0;
    for (const h of this.inputs.houses) { const l = this.ladder(h.id, itemId)[0]; if (l && l.unitPrice! < best) best = l.unitPrice!; }
    for (const v of this.inputs.vendors.get(itemId) ?? []) if (v.unitPrice < best) best = v.unitPrice;
    const recipes = this.byProduct.get(itemId) ?? [];
    if (recipes.length && (depth >= MAX_CRAFT_DEPTH || stack.has(itemId))) cut = true;
    else if (recipes.length) {
      need = 1;
      stack.add(itemId);
      for (const r of recipes) {
        let sum = 0;
        for (const g of r.reagents) {
          if (stack.has(g.itemId)) { cut = true; sum = Infinity; break; }
          const sub = this.lb(g.itemId, stack, depth + 1);
          if (sub.cut) cut = true;
          need = Math.max(need, sub.need + 1);
          sum += g.quantity * sub.v;
          // Stops a recipe that already cannot beat the best: the rest of its reagents cannot change the answer.
          if (sum >= best * this.yieldOf(r)) break;
        }
        const unit = sum / this.yieldOf(r);
        if (unit < best) best = unit;
      }
      stack.delete(itemId);
    }
    if (!cut) this.lbMemo.set(itemId, { v: best, need });
    else if (top) this.lbRoot.set(itemId, best);
    return { v: best, cut, need };
  }
  lowerBoundCraft(r: FlipRecipe): number {
    let sum = 0;
    for (const g of r.reagents) sum += g.quantity * this.lowerBound(g.itemId);
    return sum / this.yieldOf(r);
  }

  /**
   * Take one unit of an item at the cheapest source the mode allows. Returns the copper charged for this unit, or null
   * when nothing can supply it. Spare units already paid for (the rest of a vendor bundle, extra craft yield) go first.
   */
  takeOne(itemId: number, mode: TakeMode, stack: Set<number>, depth: number, trace: TraceEntry[] | null): number | null {
    const sp = this.spare.get(itemId);
    if (sp && sp.units > 0) {
      this.put(this.spare, itemId, { units: sp.units - 1, unitCost: sp.unitCost });
      this.addWaste(-sp.unitCost);
      return sp.unitCost;
    }
    let bestCost = Infinity;
    let pick: { kind: 'auction'; houseId: number; listing: Listing } | { kind: 'vendor'; v: VendorSource } | { kind: 'craft'; r: FlipRecipe } | null = null;
    for (const h of mode.houses) {
      const a = this.peekAuction(h, itemId);
      if (a && a.price < bestCost) { bestCost = a.price; pick = { kind: 'auction', houseId: h, listing: a.listing }; }
    }
    if (mode.vendor) {
      const v = this.cheapestVendor(itemId);
      if (v && v.unitPrice < bestCost) { bestCost = v.unitPrice; pick = { kind: 'vendor', v }; }
    }
    if (mode.craft && depth < MAX_CRAFT_DEPTH && !stack.has(itemId)) {
      for (const r of this.byProduct.get(itemId) ?? []) {
        if (this.cooldownLeft(r) <= 0) continue;
        // A sub craft in a profession Chip lacks is used only when nothing else supplies the reagent.
        if (pick && !this.canCraft(r)) continue;
        if (r.reagents.some(g => stack.has(g.itemId))) continue;
        const floor = this.cooldownFloor(r);
        if (Math.max(this.lowerBoundCraft(r), floor) >= bestCost) continue;
        const m = this.mark();
        const c = this.craftOnce(r, stack, depth + 1, null);
        this.rollback(m);
        if (c != null && Math.max(c / this.yieldOf(r), floor) < bestCost) { bestCost = Math.max(c / this.yieldOf(r), floor); pick = { kind: 'craft', r }; }
      }
    }
    if (!pick) return null;
    if (pick.kind === 'auction') {
      this.advanceAuction(pick.houseId, itemId);
      this.push(trace, { itemId, source: 'auction', units: 1, cost: bestCost, depth, houseId: pick.houseId, listingId: pick.listing.id });
      return bestCost;
    }
    if (pick.kind === 'vendor') {
      const v = pick.v;
      const k = `${v.npcId}:${itemId}`;
      this.put(this.vendorBought, k, (this.vendorBought.get(k) ?? 0) + v.bundle);
      if (v.bundle > 1) { this.put(this.spare, itemId, { units: v.bundle - 1, unitCost: v.unitPrice }); this.addWaste((v.bundle - 1) * v.unitPrice); }
      this.push(trace, { itemId, source: 'vendor', units: v.bundle, cost: v.unitPrice * v.bundle, depth, vendor: v });
      return v.unitPrice;
    }
    const r = pick.r;
    const c = this.craftOnce(r, stack, depth + 1, trace)!;
    const y = this.yieldOf(r);
    // A cooldown sub craft is charged at least its product's auction net: the opportunity cost of the cooldown.
    const unit = Math.max(c / y, this.cooldownFloor(r));
    const opportunity = unit * y - c;
    if (y > 1) { this.put(this.spare, itemId, { units: y - 1, unitCost: unit }); this.addWaste((y - 1) * unit); }
    this.push(trace, { itemId, source: 'craft', units: y, cost: unit * y, depth, recipeId: r.id, ...(opportunity > 0 ? { opportunity } : {}) });
    return unit;
  }

  /**
   * One craft of a recipe: its reagents taken one unit at a time at their next cheapest source. Returns the copper
   * the reagents cost, or null (with nothing changed) when a reagent has no source or the cooldown is used up.
   * `depth` is the depth of the reagents.
   */
  craftOnce(r: FlipRecipe, stack: Set<number>, depth: number, trace: TraceEntry[] | null, mode?: TakeMode): number | null {
    const m = this.mark();
    const cd = this.cooldownKey(r);
    if (cd) {
      if (this.cooldownLeft(r) <= 0) return null;
      this.put(this.cdUsed, cd, (this.cdUsed.get(cd) ?? 0) + 1);
    }
    const had = stack.has(r.productId);
    stack.add(r.productId);
    const md = mode ?? { houses: this.inputs.houses.map(h => h.id), vendor: true, craft: true };
    let total = 0;
    for (const g of r.reagents) {
      for (let q = 0; q < g.quantity; q++) {
        const c = this.takeOne(g.itemId, md, stack, depth, trace);
        if (c == null) { if (!had) stack.delete(r.productId); this.rollback(m); return null; }
        total += c;
      }
    }
    if (!had) stack.delete(r.productId);
    return total;
  }

  /** Which reagent of a recipe has no source at all right now, for the held back reason. */
  missingReagent(r: FlipRecipe): number | null {
    for (const g of r.reagents) if (!Number.isFinite(this.lowerBound(g.itemId))) return g.itemId;
    return null;
  }

  /** The cost curve of an item as steps, cheapest unit first, for the page and the recompute checks. Does not change the market. */
  curve(itemId: number, units: number, mode?: TakeMode): CostCurve {
    const m = this.mark();
    const trace: TraceEntry[] = [];
    const md = mode ?? { houses: this.inputs.houses.map(h => h.id), vendor: true, craft: true };
    for (let i = 0; i < units; i++) if (this.takeOne(itemId, md, new Set(), 0, trace) == null) break;
    const steps: CurveStep[] = [];
    for (const e of trace.filter(t => t.depth === 0)) {
      const unitCost = e.cost / e.units;
      const last = steps[steps.length - 1];
      if (last && last.source === e.source && last.unitCost === unitCost && last.houseId === e.houseId && last.recipeId === e.recipeId) { last.units += e.units; continue; }
      steps.push({ unitCost, units: e.units, source: e.source, houseId: e.houseId, recipeId: e.recipeId,
        vendor: e.vendor ? { npcId: e.vendor.npcId, npcName: e.vendor.npcName, zone: e.vendor.zone, places: e.vendor.places, bundle: e.vendor.bundle, limited: e.vendor.limited } : undefined });
    }
    this.rollback(m);
    return { itemId, steps };
  }
}
