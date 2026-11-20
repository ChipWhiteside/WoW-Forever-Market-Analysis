import type { DB } from '../store/db.ts';

/**
 * Where a recipe is learned. Three kinds, from EG Link data:
 *   trainer: a profession trainer teaches it (cost and skill needed are Forever facts),
 *   vendor: a vendor sells the recipe item ("Plans: X"), Alliance usable only,
 *   drop: a creature or object drops the recipe item, with its drop chance and kill count.
 *
 * Trainer lists match across factions: Alliance and Horde trainers of the same tier teach the same spells at the
 * same rank and cost (verified November 20 on Mining, Tailoring and Leatherworking, 89 of 89 spells, B21). EG Link has
 * no Alliance Blacksmithing trainer opened yet, so for those the cost and rank come from the Horde trainer and the
 * place comes from KNOWN_TRAINERS below, marked unconfirmed until a Forever record shows them.
 */
export type RecipeSourceKind = 'trainer' | 'vendor' | 'drop';
export interface RecipeSource {
  kind: RecipeSourceKind; who: string; zone: string | null; x: number | null; y: number | null; mapId: number | null;
  cost: number | null; skillRank: number | null; chance: number | null; kills: number | null;
  /** true when the place is from Classic knowledge or the guide, not from a Forever record */
  unconfirmed: boolean; note?: string;
}
export interface RecipeLearn {
  recipe: string;
  /** start: known as soon as the profession is learned */
  how: RecipeSourceKind | 'start' | 'unknown';
  cost: number | null; skillRank: number | null; sources: RecipeSource[]; lookup: string;
  /** what the leveling guide says about getting it, when no Forever record does */
  note?: string;
}

/** Alliance usable trainer places for professions EG Link has not recorded on the Alliance side. Unconfirmed. */
export const KNOWN_TRAINERS: Record<string, Array<{ who: string; zone: string; note: string; minRank?: number }>> = {
  Blacksmithing: [
    { who: 'Therum Deepforge', zone: 'Stormwind City', note: 'Dwarven District forge' },
    { who: 'Blacksmithing trainers', zone: 'Ironforge', note: 'The Great Forge' },
    { who: 'Brikk Keencraft', zone: 'Booty Bay', note: 'Stranglethorn Vale, for Artisan (200 and up), per the guide', minRank: 200 },
  ],
};

const RECIPE_ITEM_PREFIXES = ['Plans', 'Pattern', 'Recipe', 'Schematic', 'Formula', 'Manual'];

export const wowheadLookup = (recipe: string) => `https://www.wowhead.com/classic/search?q=${encodeURIComponent(recipe)}`;

export function recipeSources(db: DB, recipe: string, profession: string, opts: { learnSkill?: number | null; guideNote?: string } = {}): RecipeLearn {
  const sources: RecipeSource[] = [];

  const taught = db.prepare(`SELECT npc_name, faction, zone, x, y, map_id, skill_rank, cost FROM trainer_spells WHERE name = ? COLLATE NOCASE`).all(recipe) as
    Array<{ npc_name: string; faction: string; zone: string | null; x: number | null; y: number | null; map_id: number | null; skill_rank: number | null; cost: number | null }>;
  if (taught.length) {
    const cost = Math.min(...taught.map(t => t.cost ?? Infinity));
    const rank = Math.min(...taught.map(t => t.skill_rank ?? Infinity));
    const usable = taught.filter(t => t.faction !== 'horde');
    if (usable.length) {
      for (const t of usable) sources.push({ kind: 'trainer', who: t.npc_name, zone: t.zone, x: t.x, y: t.y, mapId: t.map_id, cost: t.cost, skillRank: t.skill_rank, chance: null, kills: null, unconfirmed: false });
    } else {
      for (const k of (KNOWN_TRAINERS[profession] ?? []).filter(k => k.minRank == null || rank >= k.minRank)) {
        sources.push({ kind: 'trainer', who: k.who, zone: k.zone, x: null, y: null, mapId: null, cost: Number.isFinite(cost) ? cost : null, skillRank: Number.isFinite(rank) ? rank : null, chance: null, kills: null, unconfirmed: true, note: k.note });
      }
      if (!sources.length) sources.push({ kind: 'trainer', who: `Any ${profession} trainer`, zone: null, x: null, y: null, mapId: null, cost: Number.isFinite(cost) ? cost : null, skillRank: Number.isFinite(rank) ? rank : null, chance: null, kills: null, unconfirmed: true });
    }
  }

  const names = RECIPE_ITEM_PREFIXES.map(p => `${p}: ${recipe}`);
  const items = db.prepare(`SELECT id FROM items WHERE name IN (${names.map(() => '?').join(',')})`).all(...names) as Array<{ id: number }>;
  for (const { id } of items) {
    const sold = db.prepare(`SELECT npc_name, zone, x, y, map_id, price, limited FROM vendor_items WHERE item_id = ? AND faction IN ('alliance', 'neutral') ORDER BY price`).all(id) as
      Array<{ npc_name: string; zone: string | null; x: number | null; y: number | null; map_id: number | null; price: number | null; limited: number }>;
    for (const v of sold) sources.push({ kind: 'vendor', who: v.npc_name, zone: v.zone, x: v.x, y: v.y, mapId: v.map_id, cost: v.price, skillRank: null, chance: null, kills: null, unconfirmed: false, note: v.limited ? 'limited stock, restocks over time' : undefined });
    const drops = db.prepare(`SELECT source_name, zone, chance, kills, min_level, max_level FROM loot WHERE item_id = ? AND source_name IS NOT NULL ORDER BY chance DESC LIMIT 5`).all(id) as
      Array<{ source_name: string; zone: string | null; chance: number; kills: number | null; min_level: number | null; max_level: number | null }>;
    for (const d of drops) sources.push({ kind: 'drop', who: d.source_name, zone: d.zone, x: null, y: null, mapId: null, cost: null, skillRank: null, chance: d.chance, kills: d.kills, unconfirmed: false,
      note: d.min_level ? `level ${d.min_level === d.max_level ? d.min_level : `${d.min_level} to ${d.max_level}`}` : undefined });
  }

  const first = sources.find(s => s.kind === 'trainer') ?? sources.find(s => s.kind === 'vendor') ?? sources[0];
  const start = !first && opts.learnSkill != null && opts.learnSkill <= 1;
  return {
    recipe, how: first?.kind ?? (start ? 'start' : 'unknown'), note: first ? undefined : opts.guideNote,
    cost: first?.kind === 'trainer' || first?.kind === 'vendor' ? first.cost : null,
    skillRank: sources.find(s => s.skillRank != null)?.skillRank ?? null,
    sources, lookup: wowheadLookup(recipe),
  };
}
