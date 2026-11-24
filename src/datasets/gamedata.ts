import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';

/**
 * The game's own tables for the live `wowf` build, from wago.tools (docs/flip-plan.md section 4).
 * Each table is downloaded once per build into DATA_DIR/datasets/wago/<build>/<Table>.csv and read from disk after.
 * Every column the code reads is listed below and checked on load: a renamed or missing column throws and names
 * it, so a shape change in a new build is a loud failure, never a silent zero (ledger rules 1 and 2).
 *
 * Shapes printed from real rows of build 1.60.1.71037 (November 24):
 *  - SkillLineAbility.ID is Blizzard's recipe id. Spell is the craft spell.
 *  - SpellReagents has 8 slots, Reagent_0..7 with ReagentCount_0..7. A slot can be empty before a used one
 *    (White Wedding Dress, spell 12091, has Bleach in slot 3 after an empty slot 2).
 *  - SpellEffect with Effect 24 creates EffectItemType; EffectBasePointsF is the count (0 means 1); Variance
 *    is nonzero on 9 Engineering bombs.
 *  - SpellCastTimes has Base and Minimum in ms (Smelt Copper: index 14, Base 3000, Minimum 3000).
 *  - SpellCooldowns has RecoveryTime and CategoryRecoveryTime in ms. SpellCategories.Category groups spells
 *    that share a cooldown (transmutes share category 310 "Transmute - Alchemy").
 *  - ItemSparse.Bonding: 0 none, 1 pickup, 2 equip, 3 use, 4 quest.
 */
export const WAGO_TABLES = {
  SkillLineAbility: ['ID', 'SkillLine', 'Spell', 'MinSkillLineRank', 'TrivialSkillLineRankLow', 'TrivialSkillLineRankHigh', 'TradeSkillCategoryID', 'AcquireMethod'],
  SkillLine: ['ID', 'DisplayName_lang', 'CategoryID'],
  TradeSkillCategory: ['ID', 'Name_lang'],
  SpellReagents: ['SpellID', ...slots('Reagent_'), ...slots('ReagentCount_')],
  SpellEffect: ['SpellID', 'Effect', 'EffectIndex', 'EffectItemType', 'EffectBasePointsF', 'Variance', 'DifficultyID'],
  SpellName: ['ID', 'Name_lang'],
  Spell: ['ID', 'Description_lang'],
  SpellMisc: ['SpellID', 'DifficultyID', 'CastingTimeIndex'],
  SpellCastTimes: ['ID', 'Base', 'Minimum'],
  SpellCooldowns: ['SpellID', 'DifficultyID', 'RecoveryTime', 'CategoryRecoveryTime'],
  SpellCategories: ['SpellID', 'DifficultyID', 'Category'],
  ItemSparse: ['ID', 'Display_lang', 'Bonding', 'Stackable', 'VendorStackCount', 'BuyPrice', 'SellPrice', 'OverallQualityID'],
  Item: ['ID', 'ClassID', 'SubclassID'],
  ItemEffect: ['ID', 'TriggerType', 'Charges', 'SpellID'],
  ItemXItemEffect: ['ItemEffectID', 'ItemID'],
} as const satisfies Record<string, readonly string[]>;

export type WagoTable = keyof typeof WAGO_TABLES;
export const TABLE_NAMES = Object.keys(WAGO_TABLES) as WagoTable[];

function slots(prefix: string): string[] { return Array.from({ length: 8 }, (_, i) => `${prefix}${i}`); }

/** Parse CSV text into rows. Handles quoted fields with commas, doubled quotes, and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

/** One parsed table with its header checked against what the code reads. */
export class Table {
  private readonly ix = new Map<string, number>();
  constructor(readonly name: string, readonly head: string[], readonly rows: string[][]) {
    head.forEach((h, i) => this.ix.set(h, i));
  }
  col(name: string): number {
    const i = this.ix.get(name);
    if (i == null) throw new Error(`wago ${this.name} has no ${name} column, the table shape changed`);
    return i;
  }
}

export function parseTable(name: WagoTable, text: string): Table {
  const all = parseCsv(text);
  if (!all.length) throw new Error(`wago ${name} is empty, suspected bug`);
  const t = new Table(name, all[0]!, all.slice(1));
  for (const c of WAGO_TABLES[name]) t.col(c);
  return t;
}

export interface SlaRow { id: number; skillLine: number; spellId: number; minRank: number; yellow: number; grey: number; categoryId: number; acquire: number }
export interface SparseItem { id: number; name: string; bonding: number; stackable: number; vendorStack: number; buyPrice: number; sellPrice: number; quality: number }
export interface Create { itemId: number; base: number; variance: number }
export interface Cooldown { recoveryMs: number; categoryRecoveryMs: number; category: number | null }
export interface ItemUse { itemId: number; spellId: number; trigger: number; charges: number }

/** The slice of the game tables the engine uses, indexed. Raw rows are not kept. */
export interface GameData {
  build: string;
  sla: Map<number, SlaRow>;
  skillLines: Map<number, { name: string; category: number }>;
  tradeSkillCategories: Map<number, string>;
  spellNames: Map<number, string>;
  spellDescriptions: Map<number, string>;
  /** spell -> reagents from all 8 slots, slot order kept, a repeated item summed */
  reagents: Map<number, Array<{ itemId: number; quantity: number }>>;
  /** spell -> items it creates (Effect 24), by effect index */
  creates: Map<number, Create[]>;
  /** spell -> SpellCastTimes.Base in ms */
  castMs: Map<number, number>;
  cooldowns: Map<number, Cooldown>;
  items: Map<number, SparseItem>;
  itemClass: Map<number, { classId: number; subclassId: number }>;
  itemUses: ItemUse[];
}

const num = (s: string | undefined) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };

/** Prefer the base difficulty row (DifficultyID 0) when a spell has several. */
function byBaseDifficulty(t: Table, key: string): Map<number, string[]> {
  const iKey = t.col(key), iD = t.col('DifficultyID');
  const out = new Map<number, string[]>();
  for (const r of t.rows) {
    const id = num(r[iKey]);
    const prev = out.get(id);
    if (!prev || (num(prev[iD]) !== 0 && num(r[iD]) === 0)) out.set(id, r);
  }
  return out;
}

export function buildGameData(build: string, t: Record<WagoTable, Table>): GameData {
  const sla = new Map<number, SlaRow>();
  { const s = t.SkillLineAbility; const [iId, iLine, iSpell, iMin, iLo, iHi, iCat, iAcq] = ['ID', 'SkillLine', 'Spell', 'MinSkillLineRank', 'TrivialSkillLineRankLow', 'TrivialSkillLineRankHigh', 'TradeSkillCategoryID', 'AcquireMethod'].map(c => s.col(c));
    for (const r of s.rows) sla.set(num(r[iId!]), { id: num(r[iId!]), skillLine: num(r[iLine!]), spellId: num(r[iSpell!]), minRank: num(r[iMin!]), yellow: num(r[iLo!]), grey: num(r[iHi!]), categoryId: num(r[iCat!]), acquire: num(r[iAcq!]) }); }
  const skillLines = new Map<number, { name: string; category: number }>();
  { const s = t.SkillLine; const iId = s.col('ID'), iN = s.col('DisplayName_lang'), iC = s.col('CategoryID');
    for (const r of s.rows) skillLines.set(num(r[iId]), { name: r[iN] ?? '', category: num(r[iC]) }); }
  const tradeSkillCategories = new Map<number, string>();
  { const s = t.TradeSkillCategory; const iId = s.col('ID'), iN = s.col('Name_lang');
    for (const r of s.rows) tradeSkillCategories.set(num(r[iId]), r[iN] ?? ''); }
  const spellNames = new Map<number, string>();
  { const s = t.SpellName; const iId = s.col('ID'), iN = s.col('Name_lang'); for (const r of s.rows) spellNames.set(num(r[iId]), r[iN] ?? ''); }
  const spellDescriptions = new Map<number, string>();
  { const s = t.Spell; const iId = s.col('ID'), iD = s.col('Description_lang'); for (const r of s.rows) if (r[iD]) spellDescriptions.set(num(r[iId]), r[iD]!); }
  const reagents = new Map<number, Array<{ itemId: number; quantity: number }>>();
  { const s = t.SpellReagents; const iS = s.col('SpellID');
    const ri = slots('Reagent_').map(c => s.col(c)), ci = slots('ReagentCount_').map(c => s.col(c));
    for (const r of s.rows) {
      const list: Array<{ itemId: number; quantity: number }> = [];
      for (let k = 0; k < 8; k++) {
        const id = num(r[ri[k]!]), q = num(r[ci[k]!]);
        if (id <= 0 || q <= 0) continue;
        const same = list.find(x => x.itemId === id);
        if (same) same.quantity += q; else list.push({ itemId: id, quantity: q });
      }
      if (list.length) reagents.set(num(r[iS]), list);
    } }
  const creates = new Map<number, Create[]>();
  { const s = t.SpellEffect; const iS = s.col('SpellID'), iE = s.col('Effect'), iX = s.col('EffectIndex'), iI = s.col('EffectItemType'), iB = s.col('EffectBasePointsF'), iV = s.col('Variance'), iD = s.col('DifficultyID');
    const tmp = new Map<number, Array<Create & { ix: number }>>();
    for (const r of s.rows) {
      if (num(r[iE]) !== 24 || num(r[iD]) !== 0 || num(r[iI]) <= 0) continue;
      const a = tmp.get(num(r[iS])) ?? [];
      a.push({ itemId: num(r[iI]), base: num(r[iB]), variance: num(r[iV]), ix: num(r[iX]) });
      tmp.set(num(r[iS]), a);
    }
    for (const [k, v] of tmp) creates.set(k, v.sort((a, b) => a.ix - b.ix).map(({ itemId, base, variance }) => ({ itemId, base, variance }))); }
  const castTimes = new Map<number, number>();
  { const s = t.SpellCastTimes; const iId = s.col('ID'), iB = s.col('Base'); for (const r of s.rows) castTimes.set(num(r[iId]), num(r[iB])); }
  const castMs = new Map<number, number>();
  { const s = t.SpellMisc; const iC = s.col('CastingTimeIndex');
    for (const [spell, r] of byBaseDifficulty(s, 'SpellID')) {
      const ms = castTimes.get(num(r[iC]));
      if (ms != null && ms >= 0) castMs.set(spell, ms);
    } }
  const cooldowns = new Map<number, Cooldown>();
  { const s = t.SpellCooldowns; const iR = s.col('RecoveryTime'), iC = s.col('CategoryRecoveryTime');
    const cats = byBaseDifficulty(t.SpellCategories, 'SpellID'); const iCat = t.SpellCategories.col('Category');
    for (const [spell, r] of byBaseDifficulty(s, 'SpellID')) {
      const rec = num(r[iR]), crec = num(r[iC]);
      if (rec <= 0 && crec <= 0) continue;
      const cat = num(cats.get(spell)?.[iCat]);
      cooldowns.set(spell, { recoveryMs: rec, categoryRecoveryMs: crec, category: crec > 0 && cat > 0 ? cat : null });
    } }
  const items = new Map<number, SparseItem>();
  { const s = t.ItemSparse; const [iId, iN, iB, iS, iV, iBuy, iSell, iQ] = ['ID', 'Display_lang', 'Bonding', 'Stackable', 'VendorStackCount', 'BuyPrice', 'SellPrice', 'OverallQualityID'].map(c => s.col(c));
    for (const r of s.rows) items.set(num(r[iId!]), { id: num(r[iId!]), name: r[iN!] ?? '', bonding: num(r[iB!]), stackable: num(r[iS!]), vendorStack: num(r[iV!]), buyPrice: num(r[iBuy!]), sellPrice: num(r[iSell!]), quality: num(r[iQ!]) }); }
  const itemClass = new Map<number, { classId: number; subclassId: number }>();
  { const s = t.Item; const iId = s.col('ID'), iC = s.col('ClassID'), iS = s.col('SubclassID');
    for (const r of s.rows) itemClass.set(num(r[iId]), { classId: num(r[iC]), subclassId: num(r[iS]) }); }
  const itemUses: ItemUse[] = [];
  { const e = t.ItemEffect; const iId = e.col('ID'), iT = e.col('TriggerType'), iC = e.col('Charges'), iS = e.col('SpellID');
    const effects = new Map<number, string[]>(); for (const r of e.rows) effects.set(num(r[iId]), r);
    const x = t.ItemXItemEffect; const iE = x.col('ItemEffectID'), iI = x.col('ItemID');
    for (const r of x.rows) {
      const ef = effects.get(num(r[iE]));
      if (!ef || num(ef[iS]) <= 0) continue;
      itemUses.push({ itemId: num(r[iI]), spellId: num(ef[iS]), trigger: num(ef[iT]), charges: num(ef[iC]) });
    } }
  return { build, sla, skillLines, tradeSkillCategories, spellNames, spellDescriptions, reagents, creates, castMs, cooldowns, items, itemClass, itemUses };
}

/** Read every table from one directory (a cached build, or a test fixture) and index it. */
export function loadGameDataFromDir(dir: string, build: string): GameData {
  const tables = {} as Record<WagoTable, Table>;
  for (const name of TABLE_NAMES) {
    const file = join(dir, `${name}.csv`);
    if (!existsSync(file)) throw new Error(`wago ${name} missing from ${dir}`);
    tables[name] = parseTable(name, readFileSync(file, 'utf8'));
  }
  return buildGameData(build, tables);
}

/** The newest `wowf` build wago.tools knows. */
export async function latestWowfBuild(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn('https://wago.tools/api/builds');
  if (!res.ok) throw new Error(`wago builds returned ${res.status}`);
  const builds = await res.json() as Record<string, Array<{ version: string }>>;
  const build = builds['wowf']?.[0]?.version;
  if (!build) throw new Error('wago.tools lists no wowf build, suspected bug');
  return build;
}

/**
 * Make sure every table of the latest build is on disk, downloading what is missing, then load it.
 * If wago.tools cannot be reached, the newest complete cached build is used and the caller is told.
 */
export async function fetchGameData(dataDir: string, opts: { fetchFn?: typeof fetch; log?: (m: string) => void } = {}): Promise<GameData> {
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? (() => {});
  const root = join(dataDir, 'datasets', 'wago');
  let build: string;
  try {
    build = await latestWowfBuild(fetchFn);
  } catch (e) {
    const cached = existsSync(root) ? readdirSync(root).filter(d => TABLE_NAMES.every(n => existsSync(join(root, d, `${n}.csv`)))).sort(compareBuilds) : [];
    const last = cached[cached.length - 1];
    if (!last) throw e;
    log(`gamedata: wago builds unreachable (${(e as Error).message}), using cached build ${last}`);
    build = last;
  }
  const dir = join(root, build);
  mkdirSync(dir, { recursive: true });
  for (const name of TABLE_NAMES) {
    const file = join(dir, `${name}.csv`);
    if (existsSync(file)) continue;
    const res = await fetchFn(`https://wago.tools/db2/${name}/csv?build=${build}`);
    if (!res.ok) throw new Error(`wago ${name} returned ${res.status}`);
    const text = await res.text();
    parseTable(name, text); // check the shape before it is cached
    writeFileSync(file + '.part', text);
    renameSync(file + '.part', file);
    log(`gamedata: ${name} ${build} downloaded, ${text.length} bytes`);
  }
  return loadGameDataFromDir(dir, build);
}

function compareBuilds(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

/**
 * Blizzard's binding names for ItemSparse.Bonding, so both sources use the same words (B23). Checked on 5,067 items
 * both sources know (November 24): 0 none, 1 ON_ACQUIRE, 2 ON_EQUIP, 3 ON_USE and 5 TO_BNETACCOUNT agree every time.
 * 4 QUEST is the Classic meaning, unverified: no item with Bonding 4 has Forever item data to compare.
 */
export const BONDING_TO_BINDING: Record<number, string | null> = { 0: null, 1: 'ON_ACQUIRE', 2: 'ON_EQUIP', 3: 'ON_USE', 4: 'QUEST', 5: 'TO_BNETACCOUNT' };
