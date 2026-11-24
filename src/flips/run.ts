import { FLIP_GATES, MAX_UNITS, REPEATABLE, WOBBLE } from '../rules/flips.ts';
import { money } from '../format/money.ts';
import { AUCTION_HOUSES } from '../datasets/places.ts';
import { Market } from './market.ts';
import { SellBook } from './sellBook.ts';
import { generate } from './families.ts';
import { evaluate, legsOf, auctionUse, type Candidate, type Evaluation } from './evaluate.ts';
import type { FlipInputs, FlipRecipe } from './inputs.ts';
import { FAMILY_KIND, type Flip, type FlipLeg, type FlipRunReport, type HeldBack } from './types.ts';

export interface FlipRunResult { flips: Flip[]; heldBack: HeldBack[]; report: FlipRunReport }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * One flip run over everything in `inputs`: every family over every item and recipe, each priced standalone at its
 * best quantity, gated, ranked by expected profit if Chip acts now, then a shared pass that hands out reagent
 * listings, sale capacity and gold top down. Pure apart from reading the clock for the run time.
 * A run that cannot be complete returns no list, with the reason, never a silent partial list.
 */
export function runFlips(inputs: FlipInputs): FlipRunResult {
  const t0 = Date.now();
  const dataAt = inputs.houses.length ? Math.min(...inputs.houses.map(h => h.publishedAt || inputs.now)) : inputs.now;
  const report: FlipRunReport = {
    at: inputs.now, dataAt, ms: 0, complete: true, houses: inputs.houses.map(h => h.id), items: 0, recipesTried: 0, flips: 0,
    byFamily: {}, heldBackByReason: {}, suspects: [],
  };
  if (inputs.problems.length) {
    report.complete = false;
    report.incompleteReason = inputs.problems.join('; ');
    report.ms = Date.now() - t0;
    return { flips: [], heldBack: [], report };
  }
  const recipes = new Map<number, FlipRecipe>(inputs.recipes.map(r => [r.id, r]));
  const sourceRecipes = inputs.recipes.filter(r => r.live && !r.randomYield && r.reagents.length > 0);
  const market = new Market(inputs, sourceRecipes);
  const book = new SellBook(inputs);
  const gen = generate(inputs, market, book);
  const heldBack = gen.heldBack;
  const flips: Flip[] = [];
  const evals = new Map<string, { c: Candidate; e: Evaluation }>();
  const opt = { capUsed: 0, gold: inputs.settings.goldOnHand, timeRate: inputs.settings.timeRate, horizonHours: inputs.settings.horizonHours };

  for (const c of gen.candidates) {
    const e = evaluate(c, market, inputs, recipes, opt);
    const hold = (reason: string, code: string, perItem: number | null = e.firstUnitCost != null ? Math.round(c.quote.netEach - e.firstUnitCost) : null) =>
      heldBack.push({ key: c.key, family: c.family, itemId: c.itemId, name: c.name, perItem, reason, code, sellHouseId: c.sellHouse?.id ?? null, recipeId: c.recipe?.id });
    try {
      const toVendor = c.quote.houseId == null;
      if (!e.walk.steps.length) {
        if (c.recipe && market.cooldownLeft(c.recipe) <= 0) hold('its cooldown is used up', 'cooldown', null);
        else hold('nothing can be bought for it right now', 'no supply', null);
        continue;
      }
      if (c.quote.netEach - e.firstUnitCost! <= 0) { hold(toVendor ? 'no profit at the vendor price' : 'no profit after the cut', toVendor ? 'no profit at the vendor price' : 'no profit after the cut'); continue; }
      if (!toVendor && (c.quote.salesPerDayLow ?? 0) < FLIP_GATES.minSalesPerDay) {
        hold(`sells under ${FLIP_GATES.minSalesPerDay} a day (low estimate ${round1(c.quote.salesPerDayLow ?? 0)} a day)`, 'sells under 1 a day');
        continue;
      }
      if (!e.best) { hold(`costs more than your gold on hand (${money(inputs.settings.goldOnHand)})`, 'gold on hand'); continue; }
      const b = e.best;
      const perItem = Math.round(c.quote.netEach - b.cost / b.units);
      if (b.expectedProfit <= 0) {
        hold(e.cap < 1 && !toVendor ? `not enough sells overnight: about ${round1(e.cap)} after the units ahead and new posts` : 'no expected profit once unsold units lose their deposit',
          'no expected profit overnight', perItem);
        continue;
      }
      if (!toVendor) {
        const cv = c.quote.cv ?? WOBBLE.unknownCv;
        const wobble = Math.max(WOBBLE.minCopper, Math.round(c.quote.claimPrice * cv));
        if (perItem < wobble) { hold(`profit each ${money(perItem)} is under this item's usual price wobble of ${money(wobble)}`, 'margin under price wobble', perItem); continue; }
      }
      flips.push(buildFlip(c, e, inputs, recipes, perItem));
      evals.set(c.key, { c, e });
    } finally {
      // The trace is journaled with the market, so keep a copy before the rollback empties it.
      const kept = e.walk.trace.slice();
      market.rollback(e.walk.startMark);
      e.walk.trace = kept;
    }
  }

  // Rank: expected profit at the best quantity, after the time rate (0 by default, so crafting is never buried by its minutes).
  flips.sort((a, b) => b.score! - a.score! || a.key.localeCompare(b.key));
  flips.forEach((f, i) => { f.rank = i + 1; });
  sharedPass(flips, evals, market, inputs, recipes);

  report.items = new Set([...inputs.listings.values()].flatMap(m => [...m.keys()])).size;
  report.recipesTried = inputs.recipes.length;
  report.flips = flips.length;
  for (const f of flips) report.byFamily[f.family] = (report.byFamily[f.family] ?? 0) + 1;
  for (const h of heldBack) report.heldBackByReason[h.code ?? h.reason] = (report.heldBackByReason[h.code ?? h.reason] ?? 0) + 1;
  report.suspects = suspects(inputs, flips, gen.notes);
  report.ms = Date.now() - t0;
  return { flips, heldBack, report };
}

function buildFlip(c: Candidate, e: Evaluation, inputs: FlipInputs, recipes: Map<number, FlipRecipe>, perItem: number): Flip {
  const b = e.best!;
  const step = e.walk.steps[e.bestStep]!;
  const q = c.quote;
  const toVendor = q.houseId == null;
  const buy = legsOf(e.walk.trace, step.traceEnd, inputs, recipes);
  const h = c.sellHouse;
  const sell: FlipLeg = toVendor
    ? { kind: 'any_vendor', itemId: c.itemId, name: c.name, units: b.units, unitPrice: q.netEach, who: 'Any vendor', places: [], note: 'no cut, no limit' }
    : { kind: 'auction', itemId: c.itemId, name: c.name, units: b.units, unitPrice: q.netEach, who: `${h!.faction === 'blackwater' ? 'Blackwater' : 'Alliance'} auction house`, houseId: h!.id,
      places: AUCTION_HOUSES[h!.faction === 'blackwater' ? 'blackwater' : 'alliance'], note: `post at ${money(q.undercutPrice)}, before the ${Math.round(h!.cut * 100)}% cut` };
  const notes: string[] = [];
  if (q.note) notes.push(q.note);
  if (!toVendor) {
    notes.push(`${plural(q.ahead, 'unit')} ahead of you, about ${round1(q.salesPerDayLow ?? 0)} sell a day (low estimate), about ${round1(q.newPerHour * 24)} new a day posted under you; you can expect to sell ${round1(e.cap)} overnight`);
    if (q.lowDerived) notes.push('the low sales estimate is worked out here from the sales seen; sale counting has not given one yet');
    if (q.newDerived) notes.push('new posts under you are a cautious guess; sale counting has not measured them yet');
    if (h!.faction === 'blackwater') notes.push('the Blackwater deposit is not verified yet (test T7)');
  }
  if (c.recipe) {
    const cap = c.recipe.cooldownMs ? Math.max(1, Math.ceil((inputs.settings.horizonHours * 3600_000) / c.recipe.cooldownMs)) : null;
    if (cap != null) notes.push(`its cooldown allows ${plural(cap, 'craft')} tonight`);
  }
  if (buy.some(l => l.kind === 'vendor' && l.note?.includes('limited'))) notes.push('a limited stock vendor is assumed to hold one bundle');
  if (e.goldCapped) notes.push('capped by your gold on hand');
  if (toVendor && b.units >= MAX_UNITS) notes.push(`stopped at ${MAX_UNITS} units, the most one flip is ever walked to; more may pay`);
  // Repeatable: everything bought from vendors that refill, or auction supply deep enough to do it again.
  const auction = buy.filter(l => l.kind === 'auction');
  const deep = auction.every(l => {
    const listed = (inputs.listings.get(l.houseId!)?.get(l.itemId) ?? []).reduce((a, x) => a + x.quantity, 0);
    return listed >= l.units * REPEATABLE.depthMultiple;
  });
  const vendorFed = buy.some(l => l.kind === 'vendor') && auction.length === 0 && !buy.some(l => l.kind === 'vendor' && l.note?.includes('limited'));
  const repeatable = c.family === 'cheap_listing' || c.family === 'auction_vendor' ? false : vendorFed || (auction.length > 0 && deep);
  const opening: Flip['opening'] = q.rising ? 'rising' : inputs.history.recent.has(c.key) ? null : 'new';
  return {
    key: c.key, kind: FAMILY_KIND[c.family], family: c.family, itemId: c.itemId, name: c.name,
    recipeId: c.recipe?.id, recipeName: c.recipe?.name, profession: c.recipe?.profession,
    sellHouseId: h?.id ?? null, buy, sell, perItem, best: b, options: e.options, sellQuote: q, repeatable, opening,
    openHours72: (inputs.history.openHours.get(c.key) ?? 0) + 1,
    setup: c.recipe ? setupFor(c.recipe, inputs) : null,
    shares: [], afterShared: { units: b.units, expectedProfit: b.expectedProfit },
    notes, dataAt: Math.min(...inputs.houses.filter(x => x.id === h?.id || c.buyHouseIds.includes(x.id)).map(x => x.publishedAt || inputs.now), inputs.now),
    score: b.expectedProfit,
  };
}

/** Where and for how much a recipe is learned: a trainer (Alliance or neutral first), else the item that teaches it. Never a reason to hide a flip. */
export function setupFor(r: FlipRecipe, inputs: FlipInputs): Flip['setup'] {
  const nm = r.name.toLowerCase();
  const match = inputs.trainers.filter(t => (r.spellId != null && t.spellId === r.spellId) || (t.name.toLowerCase() === nm && (!t.skill || t.skill === r.profession)));
  const usable = match.filter(t => t.faction === 'alliance' || t.faction === 'neutral');
  const pick = (usable.length ? usable : match).sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.npcId - b.npcId)[0];
  if (pick) {
    return { skill: r.profession, rank: pick.skillRank ?? r.learnSkill, cost: pick.cost,
      where: usable.length ? `${pick.npcName}${pick.zone ? `, ${pick.zone}` : ''}` : 'a trainer (no Alliance trainer recorded yet)',
      places: usable.length ? [{ label: pick.npcName, zone: pick.zone, uiMap: pick.mapId, x: pick.x, y: pick.y }] : [] };
  }
  const itemId = inputs.recipeItems.get(nm);
  if (itemId != null) {
    const v = inputs.vendors.get(itemId)?.[0];
    let floor: number | null = null;
    for (const h of inputs.houses) { const l = inputs.listings.get(h.id)?.get(itemId)?.[0]; if (l && (floor == null || l.unitPrice! < floor)) floor = l.unitPrice!; }
    const name = inputs.items.get(itemId)?.name ?? `Item ${itemId}`;
    if (v) return { skill: r.profession, rank: r.learnSkill, cost: v.unitPrice, where: `${name} from ${v.npcName}${v.zone ? `, ${v.zone}` : ''}`, places: v.places };
    return { skill: r.profession, rank: r.learnSkill, cost: floor, where: floor != null ? `${name} on the auction house` : `${name} (no seller seen)`, places: [] };
  }
  return { skill: r.profession, rank: r.learnSkill, cost: null, where: null, places: [] };
}

/**
 * The shared pass. Walk the ranked list top down; each flip takes the reagent listings, vendor stock, cooldowns, sale
 * capacity on its product and house, and gold it uses at its best quantity, and every flip below is re scored on what
 * is left. Cards keep their standalone numbers; afterShared holds the second pass numbers, and shares names the
 * higher flips it competes with.
 */
function sharedPass(flips: Flip[], evals: Map<string, { c: Candidate; e: Evaluation }>, market: Market, inputs: FlipInputs, recipes: Map<number, FlipRecipe>): void {
  const capUsed = new Map<string, number>();
  const users = new Map<string, string[]>();
  let gold = inputs.settings.goldOnHand;
  const touch = (res: string, key: string, mine: Set<string>, shares: Set<string>) => {
    for (const k of users.get(res) ?? []) if (k !== key) shares.add(k);
    mine.add(res);
  };
  for (const f of flips) {
    const { c, e: standalone } = evals.get(f.key)!;
    const capKey = c.sellHouse ? `${c.sellHouse.id}:${c.itemId}` : null;
    const e = evaluate(c, market, inputs, recipes, { capUsed: capKey ? capUsed.get(capKey) ?? 0 : 0, gold, timeRate: inputs.settings.timeRate, horizonHours: inputs.settings.horizonHours });
    const shares = new Set<string>(), mine = new Set<string>();
    const resources = (ev: Evaluation, end: number) => {
      for (let i = 0; i < end; i++) {
        const t = ev.walk.trace[i]!;
        if (t.source === 'auction') touch(`item:${t.itemId}`, f.key, mine, shares);
        else if (t.source === 'vendor' && t.vendor?.limited) touch(`vendor:${t.vendor.npcId}:${t.itemId}`, f.key, mine, shares);
        else if (t.source === 'craft') { const r = recipes.get(t.recipeId!); if (r?.cooldownMs) touch(`cd:${r.cooldownCategory ?? r.id}`, f.key, mine, shares); }
      }
    };
    resources(standalone, standalone.walk.steps[standalone.bestStep]?.traceEnd ?? 0);
    if (capKey) touch(`sell:${capKey}`, f.key, mine, shares);
    // Keep the best quantity if it still pays on what is left, else nothing.
    if (e.best && e.best.expectedProfit > 0) {
      const step = e.walk.steps[e.bestStep]!;
      resources(e, step.traceEnd);
      f.afterShared = { units: e.best.units, expectedProfit: e.best.expectedProfit };
      f.sharedUse = [...auctionUse(e.walk.trace, step.traceEnd)].map(([itemId, units]) => ({ itemId, units }));
      if (gold != null) { if (e.goldCapped) touch('gold', f.key, mine, shares); gold = Math.max(0, gold - e.best.cost); mine.add('gold'); }
      if (capKey) capUsed.set(capKey, (capUsed.get(capKey) ?? 0) + e.best.units);
      market.rollback(step.markAfter);
    } else {
      f.afterShared = { units: 0, expectedProfit: 0 };
      f.sharedUse = [];
      if (gold != null && (e.goldCapped || !e.best)) touch('gold', f.key, mine, shares);
      market.rollback(e.walk.startMark);
    }
    f.shares = [...shares];
    for (const r of mine) { const a = users.get(r) ?? []; a.push(f.key); users.set(r, a); }
  }
}

/** Zero, empty and missing are suspected bugs until proven to be market facts (ledger rule 2). */
function suspects(inputs: FlipInputs, flips: Flip[], notes: string[]): string[] {
  const out = [...inputs.notes, ...notes];
  for (const h of inputs.houses) {
    if (!(inputs.demand.get(h.id)?.size)) out.push(`house ${h.id}: no sales history, every auction sale is held back`);
    const n = inputs.listings.get(h.id)?.size ?? 0;
    if (n === 0) out.push(`house ${h.id}: no items listed`);
  }
  if (!inputs.vendors.size) out.push('no usable vendors in the catalog');
  const items = [...inputs.items.values()];
  if (items.length && !items.some(i => i.binding != null || i.bonding != null)) out.push('no item has binding data: bind on pickup products cannot be detected');
  if (inputs.recipes.length && !inputs.recipes.some(r => r.castMs != null)) out.push('no recipe has a cast time: craft minutes use the 3 second fallback');
  if (!flips.length) out.push('no flips found this run');
  return out;
}
