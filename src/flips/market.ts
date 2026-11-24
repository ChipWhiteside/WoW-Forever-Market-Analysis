import type { Listing } from '../analysis/aggregate.ts';
import { MAX_CRAFT_DEPTH, VENDOR_LIMITED_BUNDLES } from '../rules/flips.ts';
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
  private lbMemo = new Map<number, number>();

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

  yieldOf(r: FlipRecipe): number { return Math.max(1, r.qtyMin || 1); }
  cooldownKey(r: FlipRecipe): string | null {
    if (!r.cooldownMs || r.cooldownMs <= 0) return null;
    return r.cooldownCategory ? `cat:${r.cooldownCategory}` : `rec:${r.id}`;
  }
  /** Crafts a cooldown allows within the horizon: one now, then one each time it comes back. */
  cooldownCap(r: FlipRecipe): number {
    if (!r.cooldownMs || r.cooldownMs <= 0) return Infinity;
    return Math.max(1, Math.ceil((this.inputs.settings.horizonHours * 3600_000) / r.cooldownMs));
  }
  cooldownLeft(r: FlipRecipe): number {
    const k = this.cooldownKey(r);
    return k ? this.cooldownCap(r) - (this.cdUsed.get(k) ?? 0) : Infinity;
  }

  /**
   * Static lower bound on one unit's cost (cheapest listing anywhere on Chip's houses, vendor, or the bound of a
   * craft). Only used to skip pricing a craft that cannot win; never a price shown to Chip.
   */
  lowerBound(itemId: number, stack: Set<number> = new Set(), depth = 0): number {
    const memo = this.lbMemo.get(itemId);
    if (memo != null) return memo;
    let best = Infinity, cut = false;
    for (const h of this.inputs.houses) { const l = this.ladder(h.id, itemId)[0]; if (l && l.unitPrice! < best) best = l.unitPrice!; }
    for (const v of this.inputs.vendors.get(itemId) ?? []) if (v.unitPrice < best) best = v.unitPrice;
    if (depth < MAX_CRAFT_DEPTH && !stack.has(itemId)) {
      stack.add(itemId);
      for (const r of this.byProduct.get(itemId) ?? []) {
        let sum = 0;
        for (const g of r.reagents) {
          if (stack.has(g.itemId)) { cut = true; sum = Infinity; break; }
          sum += g.quantity * this.lowerBound(g.itemId, stack, depth + 1);
          if (sum >= best * this.yieldOf(r)) break;
        }
        const unit = sum / this.yieldOf(r);
        if (unit < best) best = unit;
      }
      stack.delete(itemId);
    } else cut = true;
    if (!cut || depth === 0) this.lbMemo.set(itemId, best);
    return best;
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
        if (r.reagents.some(g => stack.has(g.itemId))) continue;
        if (this.lowerBoundCraft(r) >= bestCost) continue;
        const m = this.mark();
        const c = this.craftOnce(r, stack, depth + 1, null);
        this.rollback(m);
        if (c != null && c / this.yieldOf(r) < bestCost) { bestCost = c / this.yieldOf(r); pick = { kind: 'craft', r }; }
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
    if (y > 1) { this.put(this.spare, itemId, { units: y - 1, unitCost: c / y }); this.addWaste((y - 1) * (c / y)); }
    this.push(trace, { itemId, source: 'craft', units: y, cost: c, depth, recipeId: r.id });
    return c / y;
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
