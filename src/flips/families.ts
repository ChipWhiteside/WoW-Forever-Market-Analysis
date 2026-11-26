import { CHEAP_LISTING } from '../rules/flips.ts';
import { netPerUnit } from '../rules/fees.ts';
import { money } from '../format/money.ts';
import type { Market, TakeMode } from './market.ts';
import type { SellBook } from './sellBook.ts';
import type { FlipInputs, FlipItem, FlipRecipe } from './inputs.ts';
import type { Candidate } from './evaluate.ts';
import type { Family, HeldBack, HouseRef, SellQuote } from './types.ts';
import { tradeBlock } from '../catalog/items.ts';

/**
 * Every flip family, as candidates for the evaluator. A family only says what is bought, how, and where it sells;
 * the cost book, the sell book, the queue and the gates are shared, so a Cerulean Dye and a Bright Baubles are judged
 * by the same rules. Static gates (bind on pickup, random yield, not live, no source, not listed) are applied here.
 */
export interface Generated { candidates: Candidate[]; heldBack: HeldBack[]; notes: string[] }

export const flipKey = (family: Family, sellHouseId: number | null, itemId: number, recipeId?: number) =>
  `${family}:${sellHouseId ?? 'vendor'}:${itemId}${recipeId != null ? `:${recipeId}` : ''}`;

/** Bind on pickup (Blizzard binding or the game table's Bonding 1) or a quest item: never sold on an auction house. */
export function cannotList(it: FlipItem | undefined): string | null {
  if (!it) return null;
  // One authority for both the flip engine and the conversion filter: listings, then Forever API, then ItemSparse.
  return tradeBlock(it);
}

const houseWord = (h: HouseRef) => (h.faction === 'blackwater' ? 'Blackwater' : 'Alliance');

export function generate(inputs: FlipInputs, m: Market, book: SellBook): Generated {
  const out: Generated = { candidates: [], heldBack: [], notes: [] };
  const name = (id: number) => inputs.items.get(id)?.name ?? `Item ${id}`;
  const hold = (key: string, family: Family, itemId: number, reason: string, code: string, extra: Partial<HeldBack> = {}) =>
    out.heldBack.push({ key, family, itemId, name: name(itemId), perItem: null, reason, code, ...extra });
  const allHouses = inputs.houses.map(h => h.id);
  const quoteGate = (q: SellQuote): { reason: string; code: string } | null => {
    if (!q.gates.length) return null;
    const g = q.gates[0]!;
    return { reason: g, code: g.startsWith('no sales seen') ? 'no sales near the price' : g.startsWith('strength') ? 'strength under 40' : 'sell price fails junk checks' };
  };
  /** Push a candidate after the sell side and the cheapest possible first unit are checked. */
  const offer = (c: Candidate, lbUnit: number) => {
    const g = quoteGate(c.quote);
    const perItem = Number.isFinite(lbUnit) ? c.quote.netEach - Math.round(lbUnit) : null;
    if (g) { hold(c.key, c.family, c.itemId, g.reason, g.code, { perItem, sellHouseId: c.sellHouse?.id ?? null, recipeId: c.recipe?.id }); return; }
    if (Number.isFinite(lbUnit) && lbUnit >= c.quote.netEach) {
      const v = c.quote.houseId == null;
      hold(c.key, c.family, c.itemId, v ? 'no profit at the vendor price' : 'no profit after the cut', v ? 'no profit at the vendor price' : 'no profit after the cut',
        { perItem, sellHouseId: c.sellHouse?.id ?? null, recipeId: c.recipe?.id });
      return;
    }
    out.candidates.push(c);
  };

  // Crafting: craft to auction, craft to vendor, and item use conversions, from every recipe.
  for (const r of inputs.recipes) {
    const fam: Family = r.kind === 'conversion' ? 'conversion' : 'craft_auction';
    const vfam: Family = r.kind === 'conversion' ? 'conversion' : 'craft_vendor';
    const product = inputs.items.get(r.productId);
    const keyA = (h: HouseRef) => flipKey(fam, h.id, r.productId, r.id);
    const keyV = flipKey(vfam, null, r.productId, r.id);
    // A recipe that cannot run is held back once per house; the vendor outlet is named only when it is the only one.
    const holdAll = (reason: string, code: string) => {
      if (cannotList(product)) { if (product?.sellPrice) hold(keyV, vfam, r.productId, reason, code, { sellHouseId: null, recipeId: r.id }); return; }
      for (const h of inputs.houses) hold(keyA(h), fam, r.productId, reason, code, { sellHouseId: h.id, recipeId: r.id });
    };
    if (!r.live) { holdAll('not in Forever: the product or a reagent is missing from the game', 'not live'); continue; }
    if (r.randomYield) { holdAll(`makes ${r.qtyMin} to ${r.qtyMax} at random, the yield is not proven yet`, 'random yield'); continue; }
    if (!r.reagents.length) { holdAll('the recipe has no reagents on record', 'recipe has no reagents'); continue; }
    const missing = m.missingReagent(r);
    if (missing != null) { holdAll(`no way to get ${name(missing)}: not listed, no vendor, no recipe`, 'reagent with no source'); continue; }
    if (m.cooldownLeft(r) <= 0) { holdAll('its cooldown is used up', 'cooldown'); continue; }
    const lb = m.lowerBoundCraft(r);
    const y = m.yieldOf(r);
    const acquire: Candidate['acquire'] = (mk, trace) => {
      const c = mk.craftOnce(r, new Set(), 1, trace);
      if (c == null) return null;
      mk.push(trace, { itemId: r.productId, source: 'craft', units: y, cost: c, depth: 0, recipeId: r.id });
      return { cost: c, units: y };
    };
    const noList = cannotList(product);
    for (const h of inputs.houses) {
      if (noList) { hold(keyA(h), fam, r.productId, noList, 'bind on pickup', { sellHouseId: h.id, recipeId: r.id }); continue; }
      const q = book.quote(h, r.productId);
      if (!q) { hold(keyA(h), fam, r.productId, `not listed on the ${houseWord(h)} house, no price to judge`, 'not listed', { sellHouseId: h.id, recipeId: r.id }); continue; }
      offer({ key: keyA(h), family: fam, itemId: r.productId, name: name(r.productId), recipe: r, sellHouse: h, quote: q, acquire, buyHouseIds: allHouses }, lb);
    }
    const vq = book.vendorQuote(r.productId);
    // Craft to vendor: only worth a card when the cheapest possible craft is under what a vendor pays.
    if (vq && lb < vq.netEach) offer({ key: keyV, family: vfam, itemId: r.productId, name: name(r.productId), recipe: r, sellHouse: null, quote: vq, acquire, buyHouseIds: allHouses }, lb);
  }

  // Vendor to auction: anything a usable vendor sells, listed on one of Chip's houses.
  const vendorOnly: TakeMode = { houses: [], vendor: true, craft: false };
  for (const [itemId, offers] of inputs.vendors) {
    if (!offers.length || cannotList(inputs.items.get(itemId))) continue;
    for (const h of inputs.houses) {
      const q = book.quote(h, itemId);
      if (!q) continue;
      offer({ key: flipKey('vendor_auction', h.id, itemId), family: 'vendor_auction', itemId, name: name(itemId), sellHouse: h, quote: q, buyHouseIds: [],
        acquire: (mk, trace) => { const c = mk.takeOne(itemId, vendorOnly, new Set(), 0, trace); return c == null ? null : { cost: c, units: 1 }; } },
      Math.min(...offers.map(o => o.unitPrice)));
    }
  }

  // Auction to vendor: listings under what any vendor pays, on either of Chip's houses.
  const auctionAll: TakeMode = { houses: allHouses, vendor: false, craft: false };
  const listed = new Set<number>();
  for (const per of inputs.listings.values()) for (const id of per.keys()) listed.add(id);
  for (const itemId of listed) {
    const vq = book.vendorQuote(itemId);
    if (!vq) continue;
    let floor = Infinity;
    for (const h of inputs.houses) { const l = inputs.listings.get(h.id)?.get(itemId)?.[0]; if (l && l.unitPrice! < floor) floor = l.unitPrice!; }
    if (!(floor < vq.netEach)) continue;
    offer({ key: flipKey('auction_vendor', null, itemId), family: 'auction_vendor', itemId, name: name(itemId), sellHouse: null, quote: vq, buyHouseIds: allHouses,
      acquire: (mk, trace) => { const c = mk.takeOne(itemId, auctionAll, new Set(), 0, trace); return c == null ? null : { cost: c, units: 1 }; } }, floor);
  }

  // Cross house: buy on one of Chip's houses, sell on the other. Never any other house.
  if (inputs.houses.length === 2) {
    for (const [a, b] of [[inputs.houses[0]!, inputs.houses[1]!], [inputs.houses[1]!, inputs.houses[0]!]] as Array<[HouseRef, HouseRef]>) {
      const buyMode: TakeMode = { houses: [a.id], vendor: false, craft: false };
      for (const [itemId, ls] of inputs.listings.get(a.id) ?? []) {
        if (!inputs.listings.get(b.id)?.has(itemId) || cannotList(inputs.items.get(itemId))) continue;
        const q = book.quote(b, itemId)!;
        if (!(ls[0]!.unitPrice! < q.netEach)) continue;
        offer({ key: flipKey('cross_house', b.id, itemId), family: 'cross_house', itemId, name: name(itemId), sellHouse: b, quote: q, buyHouseIds: [a.id],
          acquire: (mk, trace) => { const c = mk.takeOne(itemId, buyMode, new Set(), 0, trace); return c == null ? null : { cost: c, units: 1 }; } }, ls[0]!.unitPrice!);
      }
    }
  }

  // Cheap listing: listings at least 30 percent under the typical floor, relisted on the same house near the usual price.
  for (const h of inputs.houses) {
    const typical = inputs.typical.get(h.id);
    if (!typical?.size) { out.notes.push(`cheap listing: no typical floors yet on house ${h.id} (needs ${CHEAP_LISTING.minReadings} hourly readings)`); continue; }
    for (const [itemId, ls] of inputs.listings.get(h.id) ?? []) {
      const t = typical.get(itemId);
      if (!t || cannotList(inputs.items.get(itemId))) continue;
      const line = t.typicalFloor * (1 - CHEAP_LISTING.belowTypical);
      if (ls[0]!.unitPrice! > line) continue;
      const rest = ls.filter(l => l.unitPrice! > line);
      const base = book.quote(h, itemId, rest.length ? rest : ls)!;
      const claim = Math.min(t.typicalFloor, base.claimPrice);
      const post = Math.max(1, claim - (base.undercut ?? 1));
      // Every unit at or under Chip's post price is ahead of him, the cheap ones too: those he buys leave the queue,
      // those he does not buy stay in front of his own (round 1 finding M3). ownAhead says how many he may buy.
      const atOrUnder = ls.filter(l => l.unitPrice! <= post);
      const q: SellQuote = { ...base, claimPrice: claim, undercutPrice: post, netEach: netPerUnit(h.faction, post), ahead: atOrUnder.reduce((a, l) => a + l.quantity, 0),
        ownAhead: atOrUnder.filter(l => l.unitPrice! <= line).reduce((a, l) => a + l.quantity, 0),
        note: `relist near the usual ${money(t.typicalFloor)}; the cheap ones sit ${Math.round((1 - ls[0]!.unitPrice! / t.typicalFloor) * 100)}% under it` };
      const mode: TakeMode = { houses: [h.id], vendor: false, craft: false };
      offer({ key: flipKey('cheap_listing', h.id, itemId), family: 'cheap_listing', itemId, name: name(itemId), sellHouse: h, quote: q, buyHouseIds: [h.id],
        acquire: (mk, trace) => {
          const next = mk.peekAuction(h.id, itemId);
          if (!next || next.price > line) return null;
          const c = mk.takeOne(itemId, mode, new Set(), 0, trace);
          return c == null ? null : { cost: c, units: 1 };
        } }, ls[0]!.unitPrice!);
    }
  }

  out.candidates.push(...disenchant(inputs, out.notes));
  return out;
}

/**
 * Disenchanting: buy green gear, disenchant, sell the dust and essences. No source publishes disenchant results for
 * Forever yet (plan section 4), so this family returns nothing and says so. Nothing is invented.
 */
export function disenchant(_inputs: FlipInputs, notes: string[]): Candidate[] {
  notes.push('disenchant: held back, no data source for disenchant results yet');
  return [];
}

export type { FlipRecipe };
