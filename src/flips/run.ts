import { COOLDOWN_AUCTION, CRAFT_SESSION_MINUTES_DEFAULT, FLIP_GATES, KNOWN_TOOLS, LEARNING_HOURS, MAX_UNITS, OPENING, REPEATABLE, WOBBLE, vendorMargin } from '../rules/flips.ts';
import type { TraceEntry } from './market.ts';
import { money } from '../format/money.ts';
import { AUCTION_HOUSES, type Place } from '../datasets/places.ts';
import { Market, cooldownCrafts } from './market.ts';
import { SellBook } from './sellBook.ts';
import { generate } from './families.ts';
import { evaluate, legsOf, auctionUse, type Candidate, type Evaluation } from './evaluate.ts';
import { recipeKey, type FlipInputs, type FlipRecipe, type TrainerRow } from './inputs.ts';
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
  // A cooldown sub craft costs at least what its product nets on the auction house when listed (system review J3).
  market.opportunityOf = id => {
    let best: number | null = null;
    for (const h of inputs.houses) { const q = book.quote(h, id); if (q && (best == null || q.netEach > best)) best = q.netEach; }
    return best;
  };
  const gen = generate(inputs, market, book);
  const heldBack = gen.heldBack;
  const flips: Flip[] = [];
  const evals = new Map<string, { c: Candidate; e: Evaluation }>();
  const opt = { capUsed: 0, gold: inputs.settings.goldOnHand, timeRate: inputs.settings.timeRate, horizonHours: inputs.settings.horizonHours, craftSessionMinutes: inputs.settings.craftSessionMinutes };

  for (const c of gen.candidates) {
    const e = evaluate(c, market, inputs, recipes, opt);
    const hold = (reason: string, code: string, perItem: number | null = e.firstUnitCost != null ? Math.round(c.quote.netEach - e.firstUnitCost) : null) =>
      heldBack.push({ key: c.key, family: c.family, itemId: c.itemId, name: c.name, perItem, reason, code, sellHouseId: c.sellHouse?.id ?? null, recipeId: c.recipe?.id });
    try {
      const toVendor = c.quote.houseId == null;
      // A vendor price known only from Classic data is never ranked on (round 2 finding M3).
      if (toVendor && inputs.items.get(c.itemId)?.dataSource === 'classic1x') {
        hold('vendor price comes from Classic data, not confirmed in Forever', 'vendor_unverified');
        continue;
      }
      if (!e.walk.steps.length) {
        if (c.recipe && market.cooldownLeft(c.recipe) <= 0) hold('its cooldown is used up', 'cooldown', null);
        else hold('nothing can be bought for it right now', 'no supply', null);
        continue;
      }
      if (c.quote.netEach - e.firstUnitCost! <= 0) { hold(toVendor ? 'no profit at the vendor price' : 'no profit after the cut', toVendor ? 'no profit at the vendor price' : 'no profit after the cut'); continue; }
      // Learning: an auction sale is not ranked on under 6 hours of watched sales (round 1 finding H1).
      if (!toVendor && c.quote.hoursWatched < LEARNING_HOURS) {
        hold(`learning: ${round1(c.quote.hoursWatched)} of ${LEARNING_HOURS} hours of sales seen`, 'learning');
        continue;
      }
      if (!toVendor && c.quote.lowPending) {
        hold('learning: sale counting has no cautious sales estimate for it yet', 'learning');
        continue;
      }
      if (!toVendor && (c.quote.salesPerDayLow ?? 0) < FLIP_GATES.minSalesPerDay) {
        hold(`sells under ${FLIP_GATES.minSalesPerDay} a day (low estimate ${round1(c.quote.salesPerDayLow ?? 0)} a day)`, 'sells under 1 a day');
        continue;
      }
      if (!e.best) { hold(`costs more than your gold on hand (${money(inputs.settings.goldOnHand)})`, 'gold on hand'); continue; }
      const b = e.best;
      const perItem = Math.round(c.quote.netEach - b.cost / b.units);
      if (b.expectedProfit <= 0) {
        hold(e.cap < 1 && !toVendor ? `not enough sells overnight: about ${round1(e.cap)} expected after the units ahead and new posts` : 'no expected profit once unsold units lose their deposit',
          'no expected profit overnight', perItem);
        continue;
      }
      if (toVendor && perItem < vendorMargin(c.quote.netEach)) {
        hold(`profit each ${money(perItem)} is under the vendor margin of ${money(Math.ceil(vendorMargin(c.quote.netEach)))} (vendor rates are unverified)`, 'vendor margin too thin', perItem);
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

  // A product that sells better on the auction house (round 2 finding M4): the vendor card names the auction price, and
  // a cooldown recipe's vendor path is held back when its auction path is expected to make more (the cooldown is spent
  // either way, so only the better use of it is shown).
  const auctionBest = new Map<string, Flip>();
  for (const f of flips) if (f.sellHouseId != null) {
    const k = `${f.recipeId ?? ''}:${f.itemId}`;
    if (!auctionBest.has(k) || auctionBest.get(k)!.best.expectedProfit < f.best.expectedProfit) auctionBest.set(k, f);
  }
  for (let i = flips.length - 1; i >= 0; i--) {
    const f = flips[i]!;
    if (f.sellHouseId != null) continue;
    for (const h of inputs.houses) {
      const q = book.quote(h, f.itemId);
      if (!q || q.gates.length || q.hoursWatched < LEARNING_HOURS || !(q.netEach > f.sellQuote.netEach)) continue;
      f.notes.push(`sells for ${money(q.claimPrice)} on the ${h.faction === 'blackwater' ? 'Blackwater' : 'Alliance'} auction house`);
    }
    const better = auctionBest.get(`${f.recipeId ?? ''}:${f.itemId}`);
    if (f.recipeId != null && recipes.get(f.recipeId)?.cooldownMs && better && better.best.expectedProfit > f.best.expectedProfit) {
      heldBack.push({ key: f.key, family: f.family, itemId: f.itemId, name: f.name, perItem: f.perItem, sellHouseId: null, recipeId: f.recipeId,
        reason: `its cooldown is worth more on the auction house: about ${money(better.best.expectedProfit)} there`, code: 'auction pays more' });
      evals.delete(f.key);
      flips.splice(i, 1);
      continue;
    }
    // While the auction path is still learning, a cooldown is not spent at a vendor whose price is under half of the
    // cheapest listing (round 6 finding 3: Refined Deeprock Salt at 10s while 170 listings sat at 38g).
    if (f.recipeId != null && recipes.get(f.recipeId)?.cooldownMs && !better) {
      const learning = inputs.houses.find(h => {
        const floor = inputs.listings.get(h.id)?.get(f.itemId)?.[0]?.unitPrice;
        if (floor == null || !(floor > f.sellQuote.netEach * COOLDOWN_AUCTION.floorMultiple)) return false;
        const q = book.quote(h, f.itemId);
        return !q || q.hoursWatched < LEARNING_HOURS || q.lowPending;
      });
      if (learning) {
        heldBack.push({ key: f.key, family: f.family, itemId: f.itemId, name: f.name, perItem: f.perItem, sellHouseId: null, recipeId: f.recipeId,
          reason: COOLDOWN_LEARNING, code: 'auction likely pays more' });
        evals.delete(f.key);
        flips.splice(i, 1);
      }
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
    notes.push(`${plural(q.ahead, 'unit')} listed at or under your price, about ${round1(q.salesPerDayLow ?? 0)} sell a day (low estimate); about ${round1(b.expectedSold)} of your ${b.units} expected to sell overnight`);
    if ((b.soldTomorrow ?? 0) > 0) notes.push(`about ${round1(b.soldTomorrow!)} more expected to sell tomorrow once relisted`);
    if ((b.soldTomorrow ?? 0) > b.expectedSold) notes.push(MOSTLY_TOMORROW);
    notes.push(q.newDerived ? 'new listings under you are not measured yet for this item; none are assumed'
      : `about ${Math.round(q.newOvernight ?? 0)} new listings usually appear under you overnight`);
    if (q.lowDerived) notes.push(`the low sales estimate is worked out here from ${plural(Math.floor(q.saleEvents ?? 0), 'sale')} seen (sales counted as listings bought, not units); sale counting has not given one yet`);
    if (h!.faction === 'blackwater') notes.push('the Blackwater deposit is not verified yet (test T7)');
  }
  let setup: Flip['setup'] = null;
  if (c.recipe) {
    const cap = c.recipe.cooldownMs ? cooldownCrafts(c.recipe, inputs.settings.craftSessionMinutes ?? CRAFT_SESSION_MINUTES_DEFAULT) : null;
    if (cap != null) notes.push(`its cooldown allows ${plural(cap, 'craft')} in one crafting session`);
    setup = { ...setupFor(c.recipe, inputs)!, ...professionsNeeded(c.recipe, e.walk.trace, step.traceEnd, recipes), ...toolsFor(c.recipe) };
    if (setup.needs && setup.needs.length > 1) notes.push(`${setup.needsText}: ${setup.needs.length} professions (an alt may cover one)`);
    if (setup.unknown) {
      notes.push(setup.where ?? UNKNOWN_LEARN);
      // Not knowing how to learn the recipe makes the whole flip a gamble on the setup, so it is never low risk.
      for (const o of e.options) {
        if (!o.risk.drivers.includes(UNKNOWN_LEARN)) o.risk.drivers.push(UNKNOWN_LEARN);
        if (o.risk.level === 'low') o.risk.level = 'medium';
        // A teaching item nothing sells or drops: nobody may be able to learn it, so the flip is high risk (system review J2).
        if (setup.teachItem && setup.where?.includes(UNKNOWN_TEACH_SOURCE)) o.risk.level = 'high';
      }
    }
    // Only Horde trainers on record: a driver, never a level change; trainer lists usually match across factions (B21).
    if (c.recipe.learnSource === 'trainer_horde_only' && setup.where === HORDE_ONLY) {
      for (const o of e.options) if (!o.risk.drivers.includes(HORDE_ONLY_DRIVER)) o.risk.drivers.push(HORDE_ONLY_DRIVER);
    }
    if (setup.toolsNote) notes.push(setup.toolsNote);
  }
  if (buy.some(l => l.kind === 'vendor' && l.note?.includes('limited'))) notes.push('a limited stock vendor is assumed to hold one bundle');
  if (e.goldCapped) notes.push('capped by your gold on hand');
  if (e.sessionCapped) notes.push(`best amount kept to one ${inputs.settings.craftSessionMinutes ?? CRAFT_SESSION_MINUTES_DEFAULT} minute crafting session; the most row shows what more would make`);
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
    // earlier distinct hours plus this one, never more than the 72 hours it counts (round 1 finding L3)
    openHours72: Math.min(OPENING.trendHours, (inputs.history.openHours.get(c.key) ?? 0) + 1),
    setup,
    shares: [], afterShared: { units: b.units, expectedProfit: b.expectedProfit },
    notes, dataAt: Math.min(...inputs.houses.filter(x => x.id === h?.id || c.buyHouseIds.includes(x.id)).map(x => x.publishedAt || inputs.now), inputs.now),
    score: b.expectedProfit,
  };
}

/**
 * Where and for how much a recipe is learned. Never a reason to hide a flip. The rank is the recipe's own learn skill
 * (recipes.learn_skill), the trainer's rank only when the recipe has none (round 1 finding M4).
 *   1. A trainer Chip can use: trainer rows match by spell id, or by name when either side has no spell id.
 *   2. The item that teaches it: recipes.teach_item_id (linked by id through the game's ItemEffect table), else a
 *      name match with any prefix (Recipe:, Pattern:, Plans:, Formula:, Schematic:, Blueprint:, Manual:, Design:).
 *      Its cheapest price on Chip's houses when listed, else its vendor offer; both are named when both exist.
 *      A teaching item with no vendor, no listing and no loot record has no known source: the learn source is unknown
 *      and a risk (round 6 finding 2, Felblood Soul Bag's bind on pickup pattern).
 *   3. Only Horde trainers teach it (learn_source trainer_horde_only): said so plainly.
 */
export function setupFor(r: FlipRecipe, inputs: FlipInputs): Flip['setup'] {
  const nm = recipeKey(r.name);
  const match = inputs.trainers.filter(t => (r.spellId != null && t.spellId != null ? t.spellId === r.spellId : false)
    || ((r.spellId == null || t.spellId == null) && recipeKey(t.name) === nm && (!t.skill || t.skill === r.profession)));
  const usable = match.filter(t => t.faction === 'alliance' || t.faction === 'neutral');
  const byCost = (a: TrainerRow, b: TrainerRow) => (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.npcId - b.npcId;
  const pick = [...usable].sort(byCost)[0];
  if (pick) {
    return { skill: r.profession, rank: r.learnSkill ?? pick.skillRank, cost: pick.cost, where: `${pick.npcName}${pick.zone ? `, ${pick.zone}` : ''}`,
      places: [{ label: pick.npcName, zone: pick.zone, uiMap: pick.mapId, x: pick.x, y: pick.y }] };
  }
  const itemId = r.teachItemId ?? inputs.recipeItems.get(nm) ?? null;
  if (itemId != null) {
    const name = inputs.items.get(itemId)?.name ?? `Item ${itemId}`;
    const vendor = inputs.vendors.get(itemId)?.[0] ?? null;
    let floor: number | null = null, houseId: number | null = null;
    for (const h of inputs.houses) { const l = inputs.listings.get(h.id)?.get(itemId)?.[0]; if (l && (floor == null || l.unitPrice! < floor)) { floor = l.unitPrice!; houseId = h.id; } }
    const house = houseId != null ? inputs.houses.find(h => h.id === houseId) : null;
    const onAuction = floor != null ? `${money(floor)} on the ${house?.faction === 'blackwater' ? 'Blackwater' : 'Alliance'} auction house` : null;
    const fromVendor = vendor ? `${money(vendor.unitPrice)} from ${vendor.npcName}${vendor.zone ? `, ${vendor.zone}` : ''}` : null;
    const extra = { teachItem: { id: itemId, name }, auctionPrice: floor, auctionHouseId: houseId };
    const prices = [onAuction, fromVendor].filter(Boolean).join(', or ');
    const cost = Math.min(floor ?? Infinity, vendor?.unitPrice ?? Infinity);
    if (!prices && !inputs.lootItems?.has(itemId)) {
      return { skill: r.profession, rank: r.learnSkill, cost: null, where: `${UNKNOWN_LEARN} (${UNKNOWN_TEACH_SOURCE})`, places: [], ...extra, unknown: true };
    }
    return { skill: r.profession, rank: r.learnSkill, cost: Number.isFinite(cost) ? cost : null, where: prices ? `${name}: ${prices}` : `${name} (no seller seen)`,
      places: vendor && (floor == null || vendor.unitPrice <= floor) ? vendor.places : [], ...extra };
  }
  // Only Horde rows matched: say so plainly only when the catalog says Horde trainers alone teach it (round 2 M1).
  if (match.length || r.learnSource === 'trainer_horde_only') {
    const h = [...match].sort(byCost)[0];
    return { skill: r.profession, rank: r.learnSkill ?? h?.skillRank ?? null, cost: h?.cost ?? null,
      where: r.learnSource === 'trainer_horde_only' ? HORDE_ONLY : 'no Alliance trainer on record', places: [] };
  }
  const base = { skill: r.profession, rank: r.learnSkill, cost: null, places: [] as Place[] };
  if (r.learnSource === 'auto') return { ...base, where: 'known when the profession is learned' };
  if (r.learnSource === 'conversion') return { ...base, where: 'no recipe to learn: using the item does it' };
  if (r.learnSource === 'trainer_alliance') return { ...base, where: 'an Alliance trainer (which one is not on record)' };
  if (r.learnSource === 'item') return { ...base, where: 'taught by an item (which one is not on record)' };
  // Nothing on record (learn source missing or only the yellow skill fallback): never a reason to hide, always said (round 2 H4).
  return { ...base, where: UNKNOWN_LEARN, unknown: true };
}

/**
 * Every profession a craft tree uses at the best amount (round 2 finding H3): the top recipe and every sub craft in
 * the trace, with the highest learn skill each profession needs. Shown, never a gate: Chip has alts.
 */
export function professionsNeeded(top: FlipRecipe, trace: TraceEntry[], end: number, recipes: Map<number, FlipRecipe>): { needs: NonNullable<Flip['setup']>['needs']; needsText: string } {
  const by = new Map<string, { profession: string; rank: number | null; recipes: string[] }>();
  const add = (r: FlipRecipe) => {
    const p = by.get(r.profession) ?? { profession: r.profession, rank: null, recipes: [] };
    if (r.learnSkill != null && (p.rank == null || r.learnSkill > p.rank)) p.rank = r.learnSkill;
    if (!p.recipes.includes(r.name)) p.recipes.push(r.name);
    by.set(r.profession, p);
  };
  add(top);
  for (let i = 0; i < end; i++) { const t = trace[i]!; if (t.source === 'craft' && t.recipeId != null) { const r = recipes.get(t.recipeId); if (r) add(r); } }
  const needs = [...by.values()];
  const words = needs.map((n, i) => `${n.profession}${n.rank != null ? ` ${n.rank}` : ''}${i > 0 ? ` (${n.recipes.join(', ')})` : ''}`);
  return { needs, needsText: `needs ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]}` };
}

/**
 * Tools a recipe needs (round 2 finding M4). The game tables this build reads carry no tool requirement (SpellTotems is
 * not downloaded), so only the tools in KNOWN_TOOLS are named; a cooldown recipe without one gets a plain note.
 */
export function toolsFor(r: FlipRecipe): { tools?: string[]; toolsNote?: string } {
  const known = Object.entries(KNOWN_TOOLS).filter(([name]) => recipeKey(r.name) === recipeKey(name)).map(([, tool]) => tool);
  if (known.length) return { tools: known, toolsNote: `needs a ${known.join(' and a ')} to craft (Classic knowledge, unverified in Forever)` };
  if (r.cooldownMs) return { toolsNote: 'any tool this recipe needs is not on record yet; check it in game before buying' };
  return {};
}

/** The card line and risk driver for a recipe nobody knows how to learn yet (round 2 finding H4). */
export const UNKNOWN_LEARN = 'how to learn it is not known yet';
/** The setup line when only Horde trainers teach a recipe on record (learn_source trainer_horde_only). */
export const HORDE_ONLY = 'Horde trainers only';
/** Its risk driver (system review round 1, J1): said plainly, the level stays as it is. */
export const HORDE_ONLY_DRIVER = 'no Alliance trainer on record; trainer lists usually match across factions (B21), check in game';
/** A cooldown vendor path held back while the auction path learns (round 6 finding 3). */
export const COOLDOWN_LEARNING = 'the auction house likely pays more; waiting for sales data';
/** Why, when the only lead is a teaching item nothing sells or drops (round 6 finding 2). */
export const UNKNOWN_TEACH_SOURCE = 'the recipe item has no known source';

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
    const e = evaluate(c, market, inputs, recipes, { capUsed: capKey ? capUsed.get(capKey) ?? 0 : 0, gold, timeRate: inputs.settings.timeRate, horizonHours: inputs.settings.horizonHours, craftSessionMinutes: inputs.settings.craftSessionMinutes });
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
      // Sharing never makes a flip look better than it does alone (a bundle a higher flip paid for could otherwise).
      f.afterShared = { units: Math.min(e.best.units, f.best.units), expectedProfit: Math.min(e.best.expectedProfit, f.best.expectedProfit) };
      f.sharedUse = [...auctionUse(e.walk.trace, step.traceEnd)].map(([itemId, units]) => ({ itemId, units }));
      if (gold != null) { if (e.goldCapped) touch('gold', f.key, mine, shares); gold = Math.max(0, gold - e.best.risk.atStake); mine.add('gold'); }
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

/** The card line when more of the best amount is expected to sell tomorrow than tonight (round 2 finding H1). */
export const MOSTLY_TOMORROW = 'most of this sells tomorrow, not tonight';
