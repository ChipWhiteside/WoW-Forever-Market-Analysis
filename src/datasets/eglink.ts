import { join } from 'node:path';
import { fetchCached } from './fetchcache.ts';
import { type DB, tx } from '../store/db.ts';
import { zoneName } from './zones.ts';
import { loadNewestCachedGameData, type GameData } from './gamedata.ts';

/**
 * EG Link output: player recorded WoW Forever data, CC BY 4.0, by Efficient Games.
 * https://github.com/JIVESCORP/eg-link-output-wowf
 * Each client build has its own folder. We merge every live build: facts newest build wins,
 * counts add up, faction observations union. Shapes verified November 18 (see docs/verification.md).
 */
export const EG_BASE = 'https://raw.githubusercontent.com/JIVESCORP/eg-link-output-wowf/main/data';
export const EG_PRODUCT = 'wowf';
export const EG_ATTRIBUTION = 'Data from Efficient Games (https://efficient.games), licensed under CC BY 4.0.';

type Pos = { uiMap?: number; mapX?: number; mapY?: number };
export interface EgVendorEntry { itemId?: number; name?: string; stack?: number; limited?: boolean; stockMax?: number; costs?: Record<string, number>; costItems?: unknown[] }
export interface EgVendor { name?: string; lastSeen?: string; positions?: Pos[]; entries?: Record<string, EgVendorEntry> }
export interface EgNpc { name?: string; side?: string }
interface EgNpcFile { npcs?: Record<string, EgNpc>; objects?: Record<string, { name?: string }>; approached?: Record<string, { name?: string; positions?: Pos[] }> }
export interface EgCreature { name?: string; levels?: Record<string, number>; classifications?: string[]; reactions?: Record<string, number[]> }
export interface EgLootItem { drops?: number; quantity?: number; quest?: unknown }
export interface EgLootSource { windows?: number; items?: Record<string, EgLootItem>; positions?: Pos[] }
export interface EgQuest { title?: string; level?: number; minLevel?: number; zoneAreaId?: number; startItemId?: number; objectives?: Array<{ type?: string; objectId?: number; amount?: number }> }
export interface EgKills { deaths?: number; empty?: number; unknown?: number; levels?: Record<string, number> }

export type VendorFaction = 'alliance' | 'horde' | 'neutral' | 'unconfirmed' | 'unknown';

/**
 * NPCs proven usable by Alliance though the reaction records alone would not say so, each with its reason.
 * Add one only with a reason a person can check.
 */
export const KNOWN_NEUTRAL: Record<number, string> = {
  2626: 'Old Man Heming, Booty Bay: Chip bought Bright Baubles from him in game (verification B3, ledger V22)',
  3134: 'Kzixx, Duskwood goblin: Neutral to Horde in an Alliance zone, known neutral (round 2 review)',
};

/**
 * The Steamwheedle Cartel towns, neutral to both factions in Classic, as boxes on their zone map (percent, as the
 * vendor rows store x and y). Boxes drawn from the recorded positions of each town's NPCs (November 25):
 * Booty Bay around 27,77 in Stranglethorn Vale; Ratchet around 62,38 in the Barrens; Gadgetzan around 52,28 in
 * Tanaris; Everlook around 61,38 in Winterspring. Provisional until Chip buys from one vendor per town.
 */
export const STEAMWHEEDLE_TOWNS: Array<{ town: string; uiMap: number; x: [number, number]; y: [number, number] }> = [
  { town: 'Booty Bay', uiMap: 1434, x: [24, 32], y: [70, 85] },
  { town: 'Ratchet', uiMap: 1413, x: [60, 65.5], y: [33, 42] },
  { town: 'Gadgetzan', uiMap: 1446, x: [49, 54], y: [25, 31] },
  { town: 'Everlook', uiMap: 1452, x: [58, 63], y: [35, 40] },
];

/** The Steamwheedle town a position lies in, if any. x and y in percent of the zone map. */
export function steamwheedleTown(uiMap: number | null | undefined, x: number | null | undefined, y: number | null | undefined): string | null {
  if (uiMap == null || x == null || y == null) return null;
  return STEAMWHEEDLE_TOWNS.find(t => t.uiMap === uiMap && x >= t.x[0] && x <= t.x[1] && y >= t.y[0] && y <= t.y[1])?.town ?? null;
}

/** A position from EG Link (fractions 0 to 1) to its Steamwheedle town. */
const townOf = (pos: Pos | undefined) => steamwheedleTown(pos?.uiMap, pos?.mapX != null ? pos.mapX * 100 : null, pos?.mapY != null ? pos.mapY * 100 : null);

/**
 * Who can use a vendor, from which faction's players saw it and how it reacted to them.
 * Reaction numbers: 4 Neutral, 5 Friendly and up, 3 or less hostile. A Horde only NPC shows 5+ to Horde.
 * A named proven case (KNOWN_NEUTRAL) or an NPC in a Steamwheedle town is neutral, unless an Alliance player saw it
 * hostile. Otherwise a vendor only Horde players saw at exactly Neutral is 'unconfirmed', never usable, until an
 * Alliance player records it: EG Link creatures carry no faction id and wago's Creature table holds only pets.
 */
export function vendorFaction(reactions: Record<string, Set<number>>, sides: Set<string>, npcId?: number | string, town?: string | null): VendorFaction {
  const a = [...(reactions['Alliance'] ?? [])];
  const h = [...(reactions['Horde'] ?? [])];
  const aOk = a.some(r => r >= 4) || sides.has('Alliance');
  const hOk = h.some(r => r >= 4) || sides.has('Horde');
  if (aOk && hOk) return 'neutral';
  const aHostile = !aOk && a.length > 0;
  // An NPC EG Link records on the Horde side is Horde's, even inside a Steamwheedle town: Creeg Bothunk (263570),
  // the Darkspear Islands quartermaster, stands at 65.0, 34.6, inside the Ratchet box.
  const hordeSide = sides.has('Horde');
  if (!aHostile && !hordeSide && ((npcId != null && KNOWN_NEUTRAL[Number(npcId)]) || town)) return 'neutral';
  if (hOk && h.length && Math.max(...h) === 4 && !sides.has('Horde')) return 'unconfirmed';
  // Alliance players saw it at exactly Neutral: a neutral faction, and usable by Alliance either way.
  if (aOk && a.length && Math.max(...a) === 4 && !sides.has('Alliance')) return 'neutral';
  if (aOk) return 'alliance';
  if (hOk) return 'horde';
  return 'unknown';
}

/**
 * Reputation discounts by standing (4 Neutral, 5 Friendly, 6 Honored, 7 Revered, 8 Exalted), as Forever charges them.
 * Revered is 0.90, the same as Honored, not Classic's 0.85. Checked November 25 on 126 EG Link rows recorded at Revered
 * for an item whose Friendly or Neutral price another vendor recorded: 104 are exactly 0.90 of it, the rest 0.90 to 0.94,
 * none 0.85 (Engineer's Ink: Revered 1800, base 2000). The 6 rows with both Honored and Revered are equal. Exalted 0.8
 * is unverified: no row was recorded at Exalted.
 */
export const STANDING_DISCOUNT: Record<string, number> = { '4': 1, '5': 1, '6': 0.9, '7': 0.9, '8': 0.8 };

/** Hangul, the Korean alphabet. EG Link rows recorded by a Korean client carry Korean names. */
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
export const isHangul = (s: string | null | undefined): boolean => !!s && HANGUL.test(s);

/**
 * Korean profession names as the Korean client writes them, to Blizzard's English names. The first four are the ones
 * EG Link recorded (November 25), each checked by spell id (2329 Alchemy, 2368 Herbalism, 7731 Fishing, 2539 Cooking).
 * The rest are the client's names for the other professions, not yet seen in the data.
 */
export const KOREAN_PROFESSIONS: Record<string, string> = {
  '연금술': 'Alchemy', '약초채집': 'Herbalism', '낚시': 'Fishing', '요리': 'Cooking', '대장기술': 'Blacksmithing',
  '가죽세공': 'Leatherworking', '재봉술': 'Tailoring', '기계공학': 'Engineering', '마법부여': 'Enchanting', '채광': 'Mining',
  '무두질': 'Skinning', '응급치료': 'First Aid',
};

/**
 * One display name per NPC: the newest English name seen in any build, from the vendor or trainer record, the NPC
 * record or the creature record. A Korean name is kept only when no English one exists anywhere.
 */
export function npcNames(builds: Array<{ build: string; vendors?: Record<string, { name?: string }>; trainers?: Record<string, { name?: string }>; npcs?: Record<string, EgNpc>; creatures?: Record<string, EgCreature> }>): Map<string, string> {
  const english = new Map<string, string>(), any = new Map<string, string>();
  for (const b of [...builds].sort((x, y) => cmpBuild(x.build, y.build))) {
    for (const src of [b.creatures, b.npcs, b.trainers, b.vendors]) {
      for (const [id, o] of Object.entries(src ?? {})) {
        if (!o?.name) continue;
        any.set(id, o.name);
        if (!isHangul(o.name)) english.set(id, o.name);
      }
    }
  }
  for (const [id, n] of english) any.set(id, n);
  return any;
}

export interface MergedVendorItem {
  npcId: number; npcName: string; faction: VendorFaction; zone: string | null; x: number | null; y: number | null; uiMap: number | null;
  itemId: number; stack: number; costs: Record<string, number>; limited: boolean; lastSeen: string;
  /**
   * Lowest standing a price was recorded at, 4 Neutral to 8 Exalted. Information only: it is whoever happened to
   * record the vendor, not a requirement. The gate is the item's MinFactionID and MinReputation (vendorGate).
   */
  minStanding: number;
}

/** Reactions and sides seen per NPC across builds, for vendorFaction. */
export function factionIndex(builds: Array<{ npcs: Record<string, EgNpc>; creatures: Record<string, EgCreature> }>): { reactions: Map<string, Record<string, Set<number>>>; sides: Map<string, Set<string>> } {
  const reactions = new Map<string, Record<string, Set<number>>>();
  const sides = new Map<string, Set<string>>();
  for (const b of builds) {
    for (const [id, c] of Object.entries(b.creatures)) {
      const r = reactions.get(id) ?? {};
      for (const [f, vals] of Object.entries(c.reactions ?? {})) {
        r[f] ??= new Set();
        for (const v of vals) r[f].add(v);
      }
      reactions.set(id, r);
    }
    for (const [id, n] of Object.entries(b.npcs)) {
      if (!n.side) continue;
      const s = sides.get(id) ?? new Set<string>();
      s.add(n.side);
      sides.set(id, s);
    }
  }
  return { reactions, sides };
}

export interface EgTrainerService { spellId?: number; name?: string; skill?: string; skillRank?: number; costs?: Record<string, number> }
export interface EgTrainer { name?: string; tradeskill?: boolean; trainerType?: number; positions?: Pos[]; services?: Record<string, EgTrainerService> }
export interface MergedTrainerSpell {
  npcId: number; npcName: string; faction: VendorFaction; zone: string | null; x: number | null; y: number | null; uiMap: number | null;
  spellId: number; name: string; skill: string | null; skillRank: number | null; cost: number | null;
}

/**
 * Profession trainers and what they teach. A trainer list is the union of what players saw, so services merge
 * across builds with the newest build winning per spell. Cost is the base price (Friendly), backed out of any
 * discounted standing. Class trainers are left out.
 */
export function mergeTrainers(builds: Array<{ build: string; trainers: Record<string, EgTrainer>; npcs: Record<string, EgNpc>; creatures: Record<string, EgCreature> }>): MergedTrainerSpell[] {
  const sorted = [...builds].sort((a, b) => cmpBuild(a.build, b.build));
  const { reactions, sides } = factionIndex(sorted);
  const names = npcNames(sorted);
  // English spell and skill names per spell from any trainer in any build, for rows a Korean client recorded.
  const spellEn = new Map<number, string>(), skillEn = new Map<number, string>();
  for (const b of sorted) for (const t of Object.values(b.trainers)) for (const sv of Object.values(t.services ?? {})) {
    if (sv.spellId == null) continue;
    if (sv.name && !isHangul(sv.name)) spellEn.set(sv.spellId, sv.name);
    if (sv.skill && !isHangul(sv.skill)) skillEn.set(sv.spellId, sv.skill);
  }
  const out = new Map<string, MergedTrainerSpell>();
  for (const b of sorted) {
    for (const [npcId, t] of Object.entries(b.trainers)) {
      if (!t.tradeskill && t.trainerType !== 2) continue;
      const pos = t.positions?.[0];
      for (const sv of Object.values(t.services ?? {})) {
        if (sv.spellId == null || !sv.name) continue;
        const costs = sv.costs && Object.keys(sv.costs).length ? sv.costs : null;
        const name = isHangul(sv.name) ? spellEn.get(sv.spellId) ?? sv.name : sv.name;
        const skill = sv.skill == null ? null : isHangul(sv.skill) ? KOREAN_PROFESSIONS[sv.skill] ?? skillEn.get(sv.spellId) ?? sv.skill : sv.skill;
        out.set(`${npcId}:${sv.spellId}`, {
          npcId: Number(npcId), npcName: names.get(npcId) ?? t.name ?? `NPC ${npcId}`,
          faction: vendorFaction(reactions.get(npcId) ?? {}, sides.get(npcId) ?? new Set(), npcId, townOf(pos)),
          zone: zoneName(pos?.uiMap),
          x: pos?.mapX != null ? Math.round(pos.mapX * 1000) / 10 : null,
          y: pos?.mapY != null ? Math.round(pos.mapY * 1000) / 10 : null,
          uiMap: pos?.uiMap ?? null,
          spellId: sv.spellId, name, skill, skillRank: sv.skillRank ?? null,
          cost: costs ? vendorUnitPrice(costs, 1) : null,
        });
      }
    }
  }
  return [...out.values()];
}

export function mergeVendors(
  builds: Array<{ build: string; vendors: Record<string, EgVendor>; npcs: Record<string, EgNpc>; creatures: Record<string, EgCreature> }>,
): MergedVendorItem[] {
  const sorted = [...builds].sort((a, b) => cmpBuild(a.build, b.build));
  const { reactions, sides } = factionIndex(sorted);
  const names = npcNames(sorted);
  // Newest build that lists an NPC with entries defines that NPC's whole inventory, so an item removed or
  // repriced by a hotfix does not linger from an older build (review finding 5).
  const newest = new Map<string, EgVendor>();
  for (const b of sorted) for (const [npcId, v] of Object.entries(b.vendors)) if (v.entries && Object.keys(v.entries).length) newest.set(npcId, v);
  const out = new Map<string, MergedVendorItem>();
  for (const b of [{ vendors: Object.fromEntries(newest) }]) {
    for (const [npcId, v] of Object.entries(b.vendors)) {
      const pos = v.positions?.[0];
      for (const e of Object.values(v.entries ?? {})) {
        if (e.itemId == null || !e.costs || Object.keys(e.costs).length === 0) continue;
        if (e.costItems && e.costItems.length) continue; // costs items or currency, not plain gold
        const key = `${npcId}:${e.itemId}`;
        out.set(key, {
          npcId: Number(npcId),
          npcName: names.get(npcId) ?? v.name ?? `NPC ${npcId}`,
          faction: vendorFaction(reactions.get(npcId) ?? {}, sides.get(npcId) ?? new Set(), npcId, townOf(pos)),
          zone: zoneName(pos?.uiMap),
          x: pos?.mapX != null ? Math.round(pos.mapX * 1000) / 10 : null,
          y: pos?.mapY != null ? Math.round(pos.mapY * 1000) / 10 : null,
          uiMap: pos?.uiMap ?? null,
          itemId: e.itemId,
          stack: e.stack && e.stack > 0 ? e.stack : 1,
          costs: e.costs,
          limited: !!e.limited,
          lastSeen: v.lastSeen ?? '',
          minStanding: Math.min(...Object.keys(e.costs).map(Number).filter(Number.isFinite)),
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * The base price (Friendly, else Neutral) of a vendor entry. A recorded Friendly or Neutral price is used as is.
 * Only when none was recorded is it backed out of the lowest discounted standing, rounded to the nearest copper:
 * the game rounds the discounted price, so backing it out can land a copper off, and taking the largest back out
 * of several standings, as before, picked the copper that rounds up.
 */
export function vendorBasePrice(costs: Record<string, number>): number {
  const plain = ['5', '4', '3'].map(k => costs[k]).find(c => c != null);
  if (plain != null) return plain;
  const st = Object.keys(costs).map(Number).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (st == null) return NaN;
  return Math.round(costs[String(st)]! / (STANDING_DISCOUNT[String(st)] ?? 1));
}

/**
 * Price per unit. At a known standing with a recorded price, that price. Otherwise the base price
 * (Friendly or Neutral), backed out of a discounted standing only when no base price was recorded.
 */
export function vendorUnitPrice(costs: Record<string, number>, stack: number, standing?: number | null): number {
  const exact = standing != null ? costs[String(standing)] : undefined;
  const price = exact ?? vendorBasePrice(costs) * (standing != null ? STANDING_DISCOUNT[String(standing)] ?? 1 : 1);
  return Math.ceil(Math.round(price) / Math.max(1, stack));
}

/**
 * The standing a vendor item needs, as EG Link writes standings (4 Neutral .. 8 Exalted), from the item's own
 * ItemSparse.MinFactionID and MinReputation (MinReputation counts from 0 Hated, so EG Link's standing is one more).
 * An item with no faction requirement needs nothing: '4'. Null when the game table lacks the item.
 */
export function vendorGate(item: { minFactionId: number; minReputation: number } | undefined): string | null {
  if (!item) return null;
  return item.minFactionId > 0 ? String(item.minReputation + 1) : '4';
}

export interface MergedLoot {
  kind: string; sourceId: number; spell: number | null; itemId: number;
  /** expected units of the item per kill or per open */
  perKill: number; chance: number; kills: number; windows: number; drops: number;
}

/** Parse an EG Link loot key into its base (no |quest, |group or talent flags). */
export function parseLootKey(key: string): { base: string; kind: string; id: number; spell: number | null; group: boolean; quest: boolean } | null {
  const parts = key.split('|');
  const [kind, idStr] = (parts[0] ?? '').split(':');
  if (!kind || idStr == null) return null;
  let spell: number | null = null;
  let group = false, quest = false;
  for (const p of parts.slice(1)) {
    if (p.startsWith('spell:')) spell = Number(p.slice(6));
    else if (p === 'group') group = true;
    else if (p === 'quest') quest = true;
  }
  // Nodes and chests opened with different ranks of the same spell (Mining 2575, 2576, 3564...) are one source.
  if (kind === 'object') return { base: `object:${idStr}`, kind, id: Number(idStr), spell: null, group, quest };
  return { base: spell != null ? `${kind}:${idStr}|spell:${spell}` : `${kind}:${idStr}`, kind, id: Number(idStr), spell, group, quest };
}

/**
 * Merge loot across builds. Solo windows only (group corpses overcount empties).
 * Counts add up across builds and across |quest variants. Quest only items are left out,
 * since they drop only for characters on the quest.
 */
export function mergeLoot(builds: Array<{ sources: Record<string, EgLootSource>; kills: Record<string, EgKills> }>): MergedLoot[] {
  const agg = new Map<string, { kind: string; id: number; spell: number | null; windows: number; items: Map<number, { drops: number; quantity: number }> }>();
  const kills = new Map<string, { deaths: number; empty: number; unknown: number }>();
  for (const b of builds) {
    for (const [key, s] of Object.entries(b.sources)) {
      const k = parseLootKey(key);
      if (!k || k.group) continue;
      const a = agg.get(k.base) ?? { kind: k.kind, id: k.id, spell: k.spell, windows: 0, items: new Map() };
      a.windows += s.windows ?? 0;
      for (const [itemId, it] of Object.entries(s.items ?? {})) {
        if (it.quest) continue;
        const cur = a.items.get(Number(itemId)) ?? { drops: 0, quantity: 0 };
        cur.drops += it.drops ?? 0;
        cur.quantity += it.quantity ?? it.drops ?? 0;
        a.items.set(Number(itemId), cur);
      }
      agg.set(k.base, a);
    }
    for (const [key, kv] of Object.entries(b.kills)) {
      const k = parseLootKey(key);
      if (!k || k.group) continue;
      const cur = kills.get(k.base) ?? { deaths: 0, empty: 0, unknown: 0 };
      cur.deaths += kv.deaths ?? 0; cur.empty += kv.empty ?? 0; cur.unknown += kv.unknown ?? 0;
      kills.set(k.base, cur);
    }
  }
  const out: MergedLoot[] = [];
  for (const [base, a] of agg) {
    if (a.windows <= 0) continue;
    const kv = a.kind === 'npc' && a.spell == null ? kills.get(base) : undefined;
    const looked = kv ? kv.deaths - kv.unknown : 0;
    const share = kv && looked >= 1 ? Math.max(0, (kv.deaths - kv.empty - kv.unknown) / looked) : 1;
    for (const [itemId, it] of a.items) {
      if (it.drops <= 0) continue;
      const chance = share * (it.drops / a.windows);
      out.push({
        kind: a.kind, sourceId: a.id, spell: a.spell, itemId,
        chance: Math.round(chance * 10000) / 10000,
        perKill: chance * (it.quantity / it.drops),
        kills: kv ? looked : a.windows,
        windows: a.windows, drops: it.drops,
      });
    }
  }
  return out;
}

export function cmpBuild(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

interface EgIndex { products: Record<string, Record<string, Record<string, { records: number }>>> }

export interface GameFixes {
  /** trainer rows whose Korean spell name or skill was replaced from the game tables */
  trainerNames: number; trainerSkills: number;
  /** trainer rows still holding Korean text because no English value exists anywhere */
  trainerKorean: number;
  /** vendor rows gated by the item's own reputation requirement, and rows whose gate changed */
  vendorGated: number; vendorGateChanged: number;
  /** vendor rows whose item the game table lacks, so they keep the recorded standing */
  vendorNoItem: number;
}

/**
 * Fill what EG Link cannot know from the game's own tables: English spell names and profession names for trainer
 * rows a Korean client recorded (by spell id, through SpellName and SkillLineAbility), and each vendor item's real
 * standing gate from ItemSparse.MinFactionID and MinReputation. Idempotent; run after every EG Link or game refresh.
 */
export function applyGameToEgLink(db: DB, game: Pick<GameData, 'spellNames' | 'sla' | 'skillLines' | 'items'>): GameFixes {
  const out: GameFixes = { trainerNames: 0, trainerSkills: 0, trainerKorean: 0, vendorGated: 0, vendorGateChanged: 0, vendorNoItem: 0 };
  const lineBySpell = new Map<number, string>();
  for (const s of game.sla.values()) { const n = game.skillLines.get(s.skillLine)?.name; if (n && !isHangul(n)) lineBySpell.set(s.spellId, n); }
  tx(db, () => {
    const setName = db.prepare('UPDATE trainer_spells SET name = ? WHERE npc_id = ? AND spell_id = ?');
    const setSkill = db.prepare('UPDATE trainer_spells SET skill = ? WHERE npc_id = ? AND spell_id = ?');
    for (const r of db.prepare('SELECT npc_id, spell_id, name, skill, npc_name FROM trainer_spells').all() as Array<{ npc_id: number; spell_id: number; name: string; skill: string | null; npc_name: string }>) {
      if (isHangul(r.name)) { const en = game.spellNames.get(r.spell_id); if (en && !isHangul(en)) { setName.run(en, r.npc_id, r.spell_id); out.trainerNames++; r.name = en; } }
      if (isHangul(r.skill)) { const en = KOREAN_PROFESSIONS[r.skill!] ?? lineBySpell.get(r.spell_id); if (en) { setSkill.run(en, r.npc_id, r.spell_id); out.trainerSkills++; r.skill = en; } }
      if (isHangul(r.name) || isHangul(r.skill) || isHangul(r.npc_name)) out.trainerKorean++;
    }
    const setGate = db.prepare('UPDATE vendor_items SET standing_required = ? WHERE npc_id = ? AND item_id = ?');
    for (const r of db.prepare('SELECT npc_id, item_id, standing_required, price_by_standing FROM vendor_items').all() as Array<{ npc_id: number; item_id: number; standing_required: string | null; price_by_standing: string | null }>) {
      const gate = vendorGate(game.items.get(r.item_id));
      if (gate == null) {
        // Not in the game table: keep the recorded standing, the only evidence there is.
        out.vendorNoItem++;
        const rec = recordedStanding(r.price_by_standing);
        if (rec != null && rec !== r.standing_required) setGate.run(rec, r.npc_id, r.item_id);
        continue;
      }
      if (gate !== '4') out.vendorGated++;
      if (gate !== r.standing_required) { setGate.run(gate, r.npc_id, r.item_id); out.vendorGateChanged++; }
    }
  });
  return out;
}

function recordedStanding(json: string | null): string | null {
  try { const ks = Object.keys(JSON.parse(json ?? '{}') as object).map(Number).filter(Number.isFinite); return ks.length ? String(Math.min(...ks)) : null; } catch { return null; }
}

/** Download (cached by ETag) and merge every live build, then write vendors, loot and names into the database. */
export async function syncEgLink(db: DB, dataDir: string, log: (m: string) => void = () => {}, opts: { game?: GameData } = {}): Promise<{
  vendors: number; loot: number; names: number; builds: number; questItems: number; trainerSpells: number;
  /** distinct vendor NPCs per faction */
  vendorFactions: Record<string, number>;
  fixes: GameFixes | null;
}> {
  const dir = join(dataDir, 'datasets', 'eglink');
  const { data: index } = await fetchCached<EgIndex>(`${EG_BASE}/index.json`, join(dir, 'index.json'));
  const builds = Object.keys(index.products[EG_PRODUCT] ?? {}).sort(cmpBuild);
  if (builds.length === 0) throw new Error('EG Link index lists no live builds, suspected bug');
  const get = async <T>(build: string, ds: string): Promise<T | null> => {
    if (!index.products[EG_PRODUCT]?.[build]?.[ds]) return null;
    const { data } = await fetchCached<T>(`${EG_BASE}/${EG_PRODUCT}/${build}/${ds}.json`, join(dir, build, `${ds}.json`));
    return data;
  };
  const vendorBuilds: Parameters<typeof mergeVendors>[0] = [];
  const trainerBuilds: Parameters<typeof mergeTrainers>[0] = [];
  const lootBuilds: Parameters<typeof mergeLoot>[0] = [];
  const creatureInfo = new Map<number, { name: string; minL: number; maxL: number; cls: string; zone: string | null }>();
  const names = new Map<number, string>();
  const objectNames = new Map<number, string>();
  for (const b of builds) {
    log(`eglink ${b}`);
    const [v, n, c, l, h, t] = await Promise.all([
      get<{ vendors: Record<string, EgVendor> }>(b, 'vendors'),
      get<EgNpcFile>(b, 'npcs'),
      get<{ creatures: Record<string, EgCreature & { positions?: Pos[] }> }>(b, 'creatures'),
      get<{ sources: Record<string, EgLootSource>; kills: Record<string, EgKills> }>(b, 'loot'),
      get<{ items: Record<string, { name?: string; status?: string }> }>(b, 'item_hotfixes.enUS'),
      get<{ trainers: Record<string, EgTrainer> }>(b, 'trainers'),
    ]);
    trainerBuilds.push({ build: b, trainers: t?.trainers ?? {}, npcs: n?.npcs ?? {}, creatures: c?.creatures ?? {} });
    vendorBuilds.push({ build: b, vendors: v?.vendors ?? {}, npcs: n?.npcs ?? {}, creatures: c?.creatures ?? {} });
    for (const [id, o] of [...Object.entries(n?.objects ?? {}), ...Object.entries(n?.approached ?? {})]) if (o.name) objectNames.set(Number(id), o.name);
    if (l) lootBuilds.push({ sources: l.sources ?? {}, kills: l.kills ?? {} });
    for (const [id, cr] of Object.entries(c?.creatures ?? {})) {
      const lv = Object.keys(cr.levels ?? {}).map(Number).filter(Number.isFinite);
      creatureInfo.set(Number(id), {
        name: cr.name ?? `Creature ${id}`,
        minL: lv.length ? Math.min(...lv) : 0, maxL: lv.length ? Math.max(...lv) : 0,
        cls: (cr.classifications ?? []).join(','), zone: zoneName(cr.positions?.[0]?.uiMap),
      });
    }
    for (const [id, it] of Object.entries(h?.items ?? {})) if (it.status === 'valid' && it.name) names.set(Number(id), it.name);
  }
  // Quests that require items, from every build's quest descriptions (newest wins per quest).
  const questItems = new Map<string, { questId: number; itemId: number; amount: number; title: string; level: number | null; minLevel: number | null; zone: number | null }>();
  for (const b of builds) {
    const q = await get<{ quests: Record<string, EgQuest> }>(b, 'quests.enUS');
    for (const [qid, v] of Object.entries(q?.quests ?? {})) {
      if (/test|\(\d+\)/i.test(v.title ?? '')) continue; // developer test quests
      for (const o of v.objectives ?? []) {
        if (o.type !== 'item' || !o.objectId || !o.amount) continue;
        if (v.startItemId === o.objectId && o.amount === 1) continue; // the quest's own starting item
        questItems.set(`${qid}:${o.objectId}`, { questId: Number(qid), itemId: o.objectId, amount: o.amount, title: v.title ?? `Quest ${qid}`, level: v.level ?? null, minLevel: v.minLevel ?? null, zone: v.zoneAreaId ?? null });
      }
    }
  }
  const vendors = mergeVendors(vendorBuilds);
  const loot = mergeLoot(lootBuilds);
  const trainers = mergeTrainers(trainerBuilds);
  // Loot sources keep an English creature name when any build recorded one.
  const english = npcNames([...vendorBuilds, ...trainerBuilds]);
  for (const [id, ci] of creatureInfo) { const n = english.get(String(id)); if (n) ci.name = n; }
  tx(db, () => {
    db.exec('DELETE FROM trainer_spells');
    const it = db.prepare(`INSERT OR REPLACE INTO trainer_spells (npc_id, npc_name, faction, zone, x, y, map_id, spell_id, name, skill, skill_rank, cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of trainers) it.run(t.npcId, t.npcName, t.faction, t.zone, t.x, t.y, t.uiMap, t.spellId, t.name, t.skill, t.skillRank, t.cost);
    db.exec('DELETE FROM vendor_items');
    const iv = db.prepare(`INSERT INTO vendor_items (npc_id, npc_name, faction, zone, x, y, map_id, item_id, price, price_by_standing, units_per_purchase, limited, standing_required)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const v of vendors) iv.run(v.npcId, v.npcName, v.faction, v.zone, v.x, v.y, v.uiMap, v.itemId, vendorUnitPrice(v.costs, v.stack), JSON.stringify(v.costs), v.stack, v.limited ? 1 : 0, String(v.minStanding));
    db.exec(`DELETE FROM loot WHERE origin = 'forever'`);
    const il = db.prepare(`INSERT OR REPLACE INTO loot (source_kind, source_id, source_name, zone, min_level, max_level, classification, item_id, chance, avg_count, kills, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'forever')`);
    for (const l of loot) {
      const kind = l.spell != null ? `${l.kind}:spell${l.spell}` : l.kind;
      const ci = l.kind === 'npc' ? creatureInfo.get(l.sourceId) : undefined;
      const name = ci?.name ?? (l.kind === 'item' ? null : l.kind === 'fishing' ? `Fishing, ${zoneName(l.sourceId) ?? l.sourceId}` : l.kind === 'object' ? objectNames.get(l.sourceId) ?? `Object ${l.sourceId}` : null);
      il.run(kind, l.sourceId, name, ci?.zone ?? (l.kind === 'fishing' ? zoneName(l.sourceId) : null), ci?.minL ?? null, ci?.maxL ?? null, ci?.cls ?? null,
        l.itemId, l.chance, l.perKill, l.kills, );
    }
    const un = db.prepare(`INSERT INTO items (id, name, name_source, status, fetched_at) VALUES (?, ?, 'eglink', 0, 0)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_source = 'eglink' WHERE items.name IS NULL`);
    for (const [id, name] of names) un.run(id, name);
    db.exec('DELETE FROM quest_items');
    const iq = db.prepare('INSERT OR REPLACE INTO quest_items (quest_id, item_id, amount, title, level, min_level, zone_area) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const q of questItems.values()) iq.run(q.questId, q.itemId, q.amount, q.title, q.level, q.minLevel, q.zone);
    db.prepare(`INSERT OR REPLACE INTO datasets (name, version, fetched_at, records, note) VALUES ('eglink', ?, ?, ?, ?)`)
      .run(builds[builds.length - 1]!, Date.now(), vendors.length + loot.length, EG_ATTRIBUTION);
  });
  // The game tables from the last refresh fill English names and the vendor standing gate. On a first install they are
  // not cached yet; the recipes step right after applies the same fixes once it has downloaded them.
  const game = opts.game ?? loadNewestCachedGameData(dataDir, { log });
  let fixes: GameFixes | null = null;
  if (game) fixes = applyGameToEgLink(db, game);
  else log('eglink: no game tables cached yet, vendor gates and Korean trainer names wait for the recipes step');
  const factions: Record<string, number> = {};
  for (const v of new Map(vendors.map(v => [v.npcId, v.faction])).values()) factions[v] = (factions[v] ?? 0) + 1;
  return { vendors: vendors.length, loot: loot.length, names: names.size, builds: builds.length, questItems: questItems.size, trainerSpells: trainers.length, vendorFactions: factions, fixes };
}
