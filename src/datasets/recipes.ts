import type { BlizzardClient } from '../blizzard/client.ts';
import { ProfessionIndex, Profession, SkillTier, Recipe } from '../blizzard/contracts.ts';
import { type DB, tx } from '../store/db.ts';
import { pool, resolveItems, applyItemSparse, type ResolveResult } from '../catalog/items.ts';
import { fetchGameData, parseCsv, type GameData } from './gamedata.ts';

/**
 * Recipes, built from two sources and checked against each other (docs/flip-plan.md section 4).
 *
 * Primary: the game's own tables for the live `wowf` build on wago.tools. SkillLineAbility.ID IS Blizzard's
 * recipe id (checked November 18: recipe 1631 Rough Sharpening Stone is SLA row 1631). Reagents come from all
 * 8 SpellReagents slots, the product and its count from SpellEffect, cast time and cooldown from the spell tables.
 * Cross check and union: Blizzard's recipe API (V8, V9), which drops a reagent after an empty slot and catches the
 * rare recipe wago lacks. Every recipe says which source it came from and what the two disagree on.
 *
 * Green is the midpoint of yellow and grey, the Classic rule (1631 gives 15, 35, 55).
 */
export interface Thresholds { yellow: number; green: number; grey: number; minRank: number }

/** Kept for the threshold tests (T3): reads only the threshold columns of SkillLineAbility. */
export function parseSkillLineAbility(csv: string): Map<number, Thresholds> {
  const [head, ...rows] = parseCsv(csv);
  const ix = (n: string) => { const i = head!.indexOf(n); if (i < 0) throw new Error(`SkillLineAbility CSV has no ${n} column, shape changed`); return i; };
  const iId = ix('ID'), iMin = ix('MinSkillLineRank'), iHi = ix('TrivialSkillLineRankHigh'), iLo = ix('TrivialSkillLineRankLow');
  const out = new Map<number, Thresholds>();
  for (const c of rows) {
    const hi = Number(c[iHi]), lo = Number(c[iLo]);
    if (!hi && !lo) continue;
    out.set(Number(c[iId]), { yellow: lo, green: Math.round((lo + hi) / 2), grey: hi, minRank: Number(c[iMin]) });
  }
  return out;
}

/** One recipe as Blizzard's recipe API reports it. */
export interface BlizzardRecipe {
  id: number; name: string; professionId: number; profession: string; category: string;
  craftedItemId: number | null; qtyMin: number; qtyMax: number;
  reagents: Array<{ itemId: number; quantity: number }>;
}

export interface BuiltRecipe {
  id: number; name: string; professionId: number | null; profession: string; category: string | null;
  kind: 'profession' | 'conversion'; spellId: number | null;
  craftedItemId: number | null; qtyMin: number; qtyMax: number;
  reagents: Array<{ itemId: number; quantity: number }>;
  castMs: number | null; cooldownMs: number | null; cooldownCategory: number | null;
  randomYield: boolean;
  learnSkill: number | null; learnFrom: 'trainer' | 'yellow' | null;
  yellow: number | null; green: number | null; grey: number | null; thresholdSource: string | null;
  source: 'wago' | 'blizzard' | 'both'; disagreement: string | null;
  live: boolean;
}

export interface RecipeReport {
  build: string;
  recipes: number;
  byProfession: Record<string, { total: number; live: number }>;
  source: { wago: number; blizzard: number; both: number };
  dropped: { test: Array<{ id: number; name: string }>; seasonOfDiscovery: number };
  /** wago rows in a profession line with no reagents and no product, not recipes (skill ranks, gathering spells) */
  notCrafts: number;
  disagreements: Array<{ id: number; name: string; what: string }>;
  randomYield: Array<{ id: number; name: string }>;
  live: number; notLive: number;
  /** conversions kept, left out because an item is not in Forever, because an item cannot be traded, or because the data does not prove the counts */
  conversions: { kept: Array<{ id: number; name: string }>; notLive: number; bound: number; unproven: Array<{ spellId: number; name: string; why: string }> };
}

/** Rogue poisons are crafted from vendor and auction reagents and sell, though Blizzard's profession index omits them. */
export const EXTRA_PROFESSION_LINES = [40];
/** Conversion recipe ids live above every SkillLineAbility id: CONVERSION_ID_BASE + spell id. */
export const CONVERSION_ID_BASE = 10_000_000;
const SOD = 'SEASON OF DISCOVERY';

const fmtList = (l: Array<{ itemId: number; quantity: number }>) => l.length ? l.map(r => `${r.itemId}x${r.quantity}`).join(', ') : 'none';
const fmtQty = (a: number, b: number) => a === b ? `${round2(a)}` : `${round2(a)} to ${round2(b)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
function sameReagents(a: Array<{ itemId: number; quantity: number }>, b: Array<{ itemId: number; quantity: number }>): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(a.map(r => [r.itemId, r.quantity]));
  return b.every(r => m.get(r.itemId) === r.quantity);
}

/**
 * Join the two sources into one recipe list. Pure: every input is passed in, so the tests run on real cut fixtures.
 * `trainerRanks` maps a craft spell to the lowest skill rank any trainer teaches it at (EG Link trainers).
 * `exists` says whether an item is in Forever (B27); a recipe is live only if its product and every reagent pass.
 */
export function buildRecipes(game: GameData, blizzard: { professions: Array<{ id: number; name: string }>; recipes: BlizzardRecipe[] },
  opts: { trainerRanks: Map<number, number>; exists: (itemId: number) => boolean }): { recipes: BuiltRecipe[]; report: RecipeReport } {
  const report: RecipeReport = {
    build: game.build, recipes: 0, byProfession: {}, source: { wago: 0, blizzard: 0, both: 0 }, dropped: { test: [], seasonOfDiscovery: 0 },
    notCrafts: 0, disagreements: [], randomYield: [], live: 0, notLive: 0, conversions: { kept: [], notLive: 0, bound: 0, unproven: [] },
  };
  const profLines = new Map<number, string>();
  for (const p of blizzard.professions) profLines.set(p.id, p.name);
  for (const id of EXTRA_PROFESSION_LINES) if (!profLines.has(id)) profLines.set(id, game.skillLines.get(id)?.name ?? `Skill ${id}`);
  const bliz = new Map(blizzard.recipes.map(r => [r.id, r]));
  const ids = new Set<number>(bliz.keys());
  for (const s of game.sla.values()) {
    if (!profLines.has(s.skillLine)) continue;
    if (bliz.has(s.id)) continue;
    if (game.reagents.has(s.spellId) && game.creates.has(s.spellId)) ids.add(s.id);
    else report.notCrafts++;
  }
  const out: BuiltRecipe[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const b = bliz.get(id);
    const s = game.sla.get(id);
    const spell = s?.spellId ?? null;
    const lineName = s ? game.skillLines.get(s.skillLine)?.name : undefined;
    const profession = b?.profession ?? (s ? profLines.get(s.skillLine) ?? lineName : undefined) ?? 'Unknown';
    const name = b?.name ?? (spell ? game.spellNames.get(spell) : undefined) ?? `Recipe ${id}`;
    const wagoCategory = s && s.categoryId ? game.tradeSkillCategories.get(s.categoryId) ?? null : null;
    const category = b?.category ?? wagoCategory;
    if (/Test Profession/i.test(profession) || /Test Profession/i.test(lineName ?? '') || /\(Test\)/i.test(name)) { report.dropped.test.push({ id, name }); continue; }
    if (category?.toUpperCase() === SOD || wagoCategory?.toUpperCase() === SOD) { report.dropped.seasonOfDiscovery++; continue; }

    const wReag = spell != null ? game.reagents.get(spell) ?? [] : [];
    const wMake = spell != null ? game.creates.get(spell) ?? [] : [];
    const hasWago = !!s && (wReag.length > 0 || wMake.length > 0 || !b);
    const source: BuiltRecipe['source'] = hasWago && b ? 'both' : hasWago ? 'wago' : 'blizzard';
    const diffs: string[] = [];
    let craftedItemId: number | null, qtyMin: number, qtyMax: number, randomYield = false;
    let reagents: Array<{ itemId: number; quantity: number }>;
    if (hasWago) {
      const make = wMake[0];
      if (wMake.length > 1) diffs.push(`wago creates ${wMake.length} items, first kept: ${wMake.map(m => m.itemId).join(', ')}`);
      craftedItemId = make?.itemId ?? null;
      const base = make ? make.base || 1 : 1;
      const v = make?.variance ?? 0;
      qtyMin = v > 0 ? Math.max(1, base - v) : base; qtyMax = base + v; randomYield = v > 0;
      reagents = wReag;
      if (b) {
        if ((b.craftedItemId ?? null) !== craftedItemId) {
          diffs.push(`product: wago ${craftedItemId ?? 'none'}, blizzard ${b.craftedItemId ?? 'none'}`);
          if (craftedItemId == null) { craftedItemId = b.craftedItemId; qtyMin = b.qtyMin; qtyMax = b.qtyMax; }
        }
        if (!sameReagents(wReag, b.reagents)) {
          diffs.push(`reagents: wago ${fmtList(wReag)}; blizzard ${fmtList(b.reagents)}`);
          if (!wReag.length) reagents = b.reagents;
        }
        if (craftedItemId != null && (round2(b.qtyMin) !== round2(qtyMin) || round2(b.qtyMax) !== round2(qtyMax))) {
          diffs.push(`yield: wago ${fmtQty(qtyMin, qtyMax)}, blizzard ${fmtQty(b.qtyMin, b.qtyMax)}`);
          // Sources disagree on a random yield: keep Blizzard's whole numbers, and keep it out of the ranking until crafted in game.
          if (b.qtyMin !== b.qtyMax) { randomYield = true; qtyMin = b.qtyMin; qtyMax = b.qtyMax; }
        }
      }
    } else {
      craftedItemId = b!.craftedItemId; qtyMin = b!.qtyMin; qtyMax = b!.qtyMax; reagents = b!.reagents;
      randomYield = qtyMin !== qtyMax;
    }
    const cd = spell != null ? game.cooldowns.get(spell) : undefined;
    const hasThresholds = !!s && (s.yellow > 0 || s.grey > 0);
    const yellow = hasThresholds ? s!.yellow : null, grey = hasThresholds ? s!.grey : null;
    const trainer = spell != null ? opts.trainerRanks.get(spell) : undefined;
    const r: BuiltRecipe = {
      id, name, professionId: b?.professionId ?? s?.skillLine ?? null, profession, category, kind: 'profession', spellId: spell,
      craftedItemId, qtyMin, qtyMax, reagents,
      castMs: spell != null ? game.castMs.get(spell) ?? null : null,
      cooldownMs: cd ? Math.max(cd.recoveryMs, cd.categoryRecoveryMs) : null, cooldownCategory: cd?.category ?? null,
      randomYield,
      learnSkill: trainer ?? yellow, learnFrom: trainer != null ? 'trainer' : yellow != null ? 'yellow' : null,
      yellow, green: hasThresholds ? Math.round((s!.yellow + s!.grey) / 2) : null, grey,
      thresholdSource: hasThresholds ? `wago wowf ${game.build}` : null,
      source, disagreement: diffs.length ? diffs.join('; ') : null,
      live: (craftedItemId == null || opts.exists(craftedItemId)) && reagents.every(g => opts.exists(g.itemId)),
    };
    out.push(r);
  }
  out.push(...buildConversions(game, opts.exists, report));
  for (const r of out) {
    report.recipes++;
    report.source[r.source]++;
    const p = (report.byProfession[r.profession] ??= { total: 0, live: 0 });
    p.total++;
    if (r.live) { p.live++; report.live++; } else report.notLive++;
    if (r.disagreement) report.disagreements.push({ id: r.id, name: r.name, what: r.disagreement });
    if (r.randomYield) report.randomYield.push({ id: r.id, name: r.name });
  }
  return { recipes: out, report };
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20 };

/**
 * Item use crafts outside the profession tables (B28). An item's on use spell (ItemEffect TriggerType 0) that
 * creates one item with a fixed count. Inputs: the spell's reagents, plus the item itself when its use consumes
 * it (Charges below 0). Lesser Magic Essence: reagents 2 of itself, consumed on use, so 3 in, as the spell text
 * says ("Turn three lesser magic essences into a greater one"). A conversion is kept only when its spell text
 * names every count above 1, so inputs and outputs are proven from data, only when every item is in Forever, and
 * only when the game table shows every item can be traded (quest spells like "fill the flask" are left out).
 */
export function buildConversions(game: GameData, exists: (itemId: number) => boolean, report?: RecipeReport): BuiltRecipe[] {
  const slaSpells = new Set([...game.sla.values()].map(s => s.spellId));
  const bySpell = new Map<number, Array<{ itemId: number; inputs: Array<{ itemId: number; quantity: number }> }>>();
  for (const u of game.itemUses) {
    if (u.trigger !== 0 || slaSpells.has(u.spellId)) continue;
    const make = game.creates.get(u.spellId);
    if (!make?.length) continue;
    const inputs = (game.reagents.get(u.spellId) ?? []).map(r => ({ ...r }));
    if (u.charges < 0) {
      const self = inputs.find(r => r.itemId === u.itemId);
      if (self) self.quantity += 1; else inputs.unshift({ itemId: u.itemId, quantity: 1 });
    }
    const a = bySpell.get(u.spellId) ?? [];
    a.push({ itemId: u.itemId, inputs });
    bySpell.set(u.spellId, a);
  }
  const out: BuiltRecipe[] = [];
  const unproven = (spellId: number, why: string) => report?.conversions.unproven.push({ spellId, name: game.spellNames.get(spellId) ?? `Spell ${spellId}`, why });
  for (const [spellId, uses] of [...bySpell].sort((a, b) => a[0] - b[0])) {
    const make = game.creates.get(spellId)!;
    const name = game.spellNames.get(spellId) ?? `Spell ${spellId}`;
    if (make.length !== 1) { unproven(spellId, `creates ${make.length} items`); continue; }
    if (make[0]!.variance !== 0) { unproven(spellId, 'random count'); continue; }
    const inputs = uses[0]!.inputs;
    if (!inputs.length) { unproven(spellId, 'no input is used up'); continue; }
    if (uses.some(u => !sameReagents(u.inputs, inputs))) { unproven(spellId, 'items that cast it use different inputs'); continue; }
    const outQty = make[0]!.base || 1;
    const product = make[0]!.itemId;
    if (inputs.length === 1 && inputs[0]!.itemId === product) { unproven(spellId, 'makes what it uses'); continue; }
    const desc = (game.spellDescriptions.get(spellId) ?? '').toLowerCase();
    const said = new Set<number>();
    for (const w of desc.match(/\$?[a-z0-9]+/g) ?? []) { if (w.startsWith('$')) continue; const n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w]; if (n != null) said.add(n); }
    const needed = [...inputs.map(i => i.quantity), outQty].filter(n => n > 1);
    if (needed.some(n => !said.has(n))) { unproven(spellId, `spell text does not state the counts ${needed.join(', ')}`); continue; }
    const live = exists(product) && inputs.every(i => exists(i.itemId));
    if (!live) { if (report) report.conversions.notLive++; continue; }
    // Quest items (fill a flask, sign a paper) pass every rule above but can never be bought or sold. Keep a conversion
    // only when the game table shows every item it touches can be traded: bonding none, on equip or on use.
    const bound = [product, ...inputs.map(i => i.itemId)].filter(i => { const b = game.items.get(i)?.bonding; return b == null || b === 1 || b === 4; });
    if (bound.length) { if (report) report.conversions.bound++; continue; }
    const cd = game.cooldowns.get(spellId);
    const id = CONVERSION_ID_BASE + spellId;
    out.push({
      id, name, professionId: null, profession: 'Conversion', category: 'Item use', kind: 'conversion', spellId,
      craftedItemId: product, qtyMin: outQty, qtyMax: outQty, reagents: inputs,
      castMs: game.castMs.get(spellId) ?? null,
      cooldownMs: cd ? Math.max(cd.recoveryMs, cd.categoryRecoveryMs) : null, cooldownCategory: cd?.category ?? null,
      randomYield: false, learnSkill: null, learnFrom: null, yellow: null, green: null, grey: null, thresholdSource: null,
      source: 'wago', disagreement: null, live: true,
    });
    report?.conversions.kept.push({ id, name });
  }
  return out;
}

/** Replace the recipe tables with a built list. */
export function writeRecipes(db: DB, recipes: BuiltRecipe[], note: { version: string; note: string }): void {
  tx(db, () => {
    db.exec('DELETE FROM recipes; DELETE FROM recipe_reagents;');
    const ir = db.prepare(`INSERT INTO recipes (id, name, profession_id, profession, category, crafted_item_id, qty_min, qty_max, learn_skill, yellow, green, grey,
        threshold_source, spell_id, cast_ms, cooldown_ms, cooldown_category, random_yield, live, kind, source, disagreement)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ig = db.prepare('INSERT INTO recipe_reagents (recipe_id, item_id, quantity) VALUES (?, ?, ?)');
    for (const r of recipes) {
      ir.run(r.id, r.name, r.professionId, r.profession, r.category, r.craftedItemId, r.qtyMin, r.qtyMax, r.learnSkill, r.yellow, r.green, r.grey,
        r.thresholdSource, r.spellId, r.castMs, r.cooldownMs, r.cooldownCategory, r.randomYield ? 1 : 0, r.live ? 1 : 0, r.kind, r.source, r.disagreement);
      for (const g of r.reagents) ig.run(r.id, g.itemId, g.quantity);
    }
    db.prepare(`INSERT OR REPLACE INTO datasets (name, version, fetched_at, records, note) VALUES ('recipes', ?, ?, ?, ?)`).run(note.version, Date.now(), recipes.length, note.note);
  });
}

/** Walk Blizzard's profession index down to every recipe. Paced by the client; 4 at a time. */
export async function fetchBlizzardRecipes(client: BlizzardClient, log: (m: string) => void = () => {}): Promise<{ professions: Array<{ id: number; name: string }>; recipes: BlizzardRecipe[]; refs: number; failed: number }> {
  const idx = await client.get(client.url('/data/wow/profession/index', 'static'), ProfessionIndex);
  if (!idx.body?.professions.length) throw new Error('profession index empty, suspected bug');
  const refs: Array<{ id: number; profId: number; prof: string; category: string }> = [];
  for (const p of idx.body.professions) {
    const prof = await client.get(client.url(`/data/wow/profession/${p.id}`, 'static'), Profession);
    for (const t of prof.body?.skill_tiers ?? []) {
      const tier = await client.get(client.url(`/data/wow/profession/${p.id}/skill-tier/${t.id}`, 'static'), SkillTier);
      for (const c of tier.body?.categories ?? []) for (const r of c.recipes ?? []) refs.push({ id: r.id, profId: p.id, prof: p.name, category: c.name });
    }
  }
  log(`recipes: walking ${refs.length} Blizzard recipes`);
  const recipes: BlizzardRecipe[] = [];
  let failed = 0;
  await pool(refs, 4, async ref => {
    try {
      const b = (await client.get(client.url(`/data/wow/recipe/${ref.id}`, 'static'), Recipe)).body;
      if (!b) { failed++; return; }
      const item = b.crafted_item ?? b.alliance_crafted_item;
      const q = b.crafted_quantity;
      recipes.push({ id: b.id, name: b.name, professionId: ref.profId, profession: ref.prof, category: ref.category, craftedItemId: item?.id ?? null,
        qtyMin: q?.minimum ?? q?.value ?? 1, qtyMax: q?.maximum ?? q?.value ?? 1, reagents: (b.reagents ?? []).map(r => ({ itemId: r.reagent.id, quantity: r.quantity })) });
    } catch { failed++; }
  });
  return { professions: idx.body.professions.map(p => ({ id: p.id, name: p.name })), recipes, refs: refs.length, failed };
}

/** Items that exist in Forever (B27): Blizzard's Forever item data, the game's Forever item table, or listed on a tracked house. */
export function foreverItems(db: DB, game: Pick<GameData, 'items'>): (itemId: number) => boolean {
  const known = new Set<number>();
  for (const r of db.prepare(`SELECT id FROM items WHERE status = 200 AND (data_source IS NULL OR data_source = 'forever')`).all() as Array<{ id: number }>) known.add(r.id);
  for (const r of db.prepare(`SELECT DISTINCT item_id FROM item_stats WHERE listings > 0 AND house_id IN (SELECT id FROM houses WHERE tracked = 1)
    UNION SELECT DISTINCT item_id FROM item_daily WHERE house_id IN (SELECT id FROM houses WHERE tracked = 1)`).all() as Array<{ item_id: number }>) known.add(r.item_id);
  return id => known.has(id) || game.items.has(id);
}

export interface SyncRecipesResult {
  recipes: number; withThresholds: number; unmatched: number;
  report: RecipeReport; items: ResolveResult;
  sparse: { updated: number; compared: number; disagree: Array<{ id: number; blizzard: string | null; bonding: number }> };
  blizzard: { refs: number; fetched: number; failed: number };
}

/** One log line for the daily refresh. */
export function summarizeRecipes(r: SyncRecipesResult): string {
  const p = r.report;
  return `${r.recipes} recipes (${p.source.both} both sources, ${p.source.wago} wago only, ${p.source.blizzard} blizzard only), ${p.live} live, `
    + `${p.disagreements.length} disagreements, ${p.randomYield.length} random yield, ${p.conversions.kept.length} conversions, `
    + `dropped ${p.dropped.test.length} test and ${p.dropped.seasonOfDiscovery} Season of Discovery; items ${r.items.bySource.forever} forever, `
    + `${r.items.bySource.classic1x} classic1x, ${r.items.bySource.wago} game table only, ${r.items.bySource.none} unknown; `
    + `binding vs ItemSparse disagree on ${r.sparse.disagree.length} of ${r.sparse.compared}`;
}

/**
 * The daily static data refresh: game tables, Blizzard recipes, the union and cross check, every product and
 * reagent resolved in the item catalog, then the live filter. Keeps the exported name the engine calls.
 */
export async function syncRecipes(client: BlizzardClient, db: DB, dataDir: string, log: (m: string) => void = () => {},
  opts: { game?: GameData; fetchFn?: typeof fetch } = {}): Promise<SyncRecipesResult> {
  const game = opts.game ?? await fetchGameData(dataDir, { fetchFn: opts.fetchFn, log });
  const bz = await fetchBlizzardRecipes(client, log);
  if (bz.failed > bz.refs * 0.05) throw new Error(`Blizzard recipe fetch failed for ${bz.failed} of ${bz.refs}, will retry`);
  const trainerRanks = new Map<number, number>();
  for (const r of db.prepare('SELECT spell_id, MIN(skill_rank) AS rank FROM trainer_spells WHERE skill_rank IS NOT NULL GROUP BY spell_id').all() as Array<{ spell_id: number; rank: number }>) trainerRanks.set(r.spell_id, r.rank);
  // First pass only to learn which items the recipes touch, so every one is in the catalog before the live filter.
  const draft = buildRecipes(game, bz, { trainerRanks, exists: () => true });
  const ids = new Set<number>();
  for (const r of draft.recipes) { if (r.craftedItemId) ids.add(r.craftedItemId); for (const g of r.reagents) ids.add(g.itemId); }
  const items = await resolveItems(client, db, [...ids], { maxAgeMs: Infinity, game });
  log(`recipes: ${ids.size} recipe items, ${items.fetched} fetched (${items.bySource.forever} forever, ${items.bySource.classic1x} classic1x), ${items.bySource.wago} from the game table only, ${items.bySource.none} unknown, ${items.errors} errors, ${client.throttled} throttled so far`);
  const sparse = applyItemSparse(db, game);
  const { recipes, report } = buildRecipes(game, bz, { trainerRanks, exists: foreverItems(db, game) });
  const withThresholds = recipes.filter(r => r.yellow != null).length;
  writeRecipes(db, recipes, {
    version: `wago ${game.build} + blizzard`,
    note: `${report.source.both} both, ${report.source.wago} wago only, ${report.source.blizzard} blizzard only; ${report.live} live; ${report.disagreements.length} disagree; dropped ${report.dropped.test.length} test and ${report.dropped.seasonOfDiscovery} Season of Discovery; ${report.conversions.kept.length} conversions`,
  });
  db.prepare(`INSERT OR REPLACE INTO datasets (name, version, fetched_at, records, note) VALUES ('gamedata', ?, ?, ?, ?)`)
    .run(game.build, Date.now(), game.items.size, `wago wowf tables; binding agrees with ItemSparse on ${sparse.compared - sparse.disagree.length} of ${sparse.compared}`);
  return { recipes: recipes.length, withThresholds, unmatched: bz.failed, report, items, sparse, blizzard: { refs: bz.refs, fetched: bz.recipes.length, failed: bz.failed } };
}
