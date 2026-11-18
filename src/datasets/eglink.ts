import { join } from 'node:path';
import { fetchCached } from './fetchcache.ts';
import { type DB, tx } from '../store/db.ts';
import { zoneName } from './zones.ts';

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
export interface EgCreature { name?: string; levels?: Record<string, number>; classifications?: string[]; reactions?: Record<string, number[]> }
export interface EgLootItem { drops?: number; quantity?: number; quest?: unknown }
export interface EgLootSource { windows?: number; items?: Record<string, EgLootItem>; positions?: Pos[] }
export interface EgKills { deaths?: number; empty?: number; unknown?: number; levels?: Record<string, number> }

export type VendorFaction = 'alliance' | 'horde' | 'neutral' | 'unknown';

/**
 * Who can use a vendor, from which faction's players saw it and how it reacted to them.
 * Reaction numbers: 4 Neutral, 5 Friendly and up. A Horde only NPC shows 5+ to Horde and is never seen by Alliance.
 */
export function vendorFaction(reactions: Record<string, Set<number>>, sides: Set<string>): VendorFaction {
  const a = [...(reactions['Alliance'] ?? [])];
  const h = [...(reactions['Horde'] ?? [])];
  const aOk = a.some(r => r >= 4) || sides.has('Alliance');
  const hOk = h.some(r => r >= 4) || sides.has('Horde');
  if (aOk && hOk) return 'neutral';
  // A vendor opened at exactly Neutral (4) belongs to a neutral faction such as the goblins of
  // Booty Bay or Ratchet: the other faction's own NPCs are Friendly or better to their players.
  if (hOk && h.length && Math.max(...h) === 4 && !sides.has('Horde')) return 'neutral';
  if (aOk && a.length && Math.max(...a) === 4 && !sides.has('Alliance')) return 'neutral';
  if (aOk) return 'alliance';
  if (hOk) return 'horde';
  return 'unknown';
}

/** Classic reputation discounts by standing (4 Neutral, 5 Friendly, 6 Honored, 7 Revered, 8 Exalted). */
export const STANDING_DISCOUNT: Record<string, number> = { '4': 1, '5': 1, '6': 0.9, '7': 0.85, '8': 0.8 };

export interface MergedVendorItem {
  npcId: number; npcName: string; faction: VendorFaction; zone: string | null; x: number | null; y: number | null; uiMap: number | null;
  itemId: number; stack: number; costs: Record<string, number>; limited: boolean; lastSeen: string;
}

export function mergeVendors(
  builds: Array<{ build: string; vendors: Record<string, EgVendor>; npcs: Record<string, EgNpc>; creatures: Record<string, EgCreature> }>,
): MergedVendorItem[] {
  const sorted = [...builds].sort((a, b) => cmpBuild(a.build, b.build));
  const reactions = new Map<string, Record<string, Set<number>>>();
  const sides = new Map<string, Set<string>>();
  for (const b of sorted) {
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
  const out = new Map<string, MergedVendorItem>();
  for (const b of sorted) {
    for (const [npcId, v] of Object.entries(b.vendors)) {
      const pos = v.positions?.[0];
      for (const e of Object.values(v.entries ?? {})) {
        if (e.itemId == null || !e.costs || Object.keys(e.costs).length === 0) continue;
        if (e.costItems && e.costItems.length) continue; // costs items or currency, not plain gold
        const key = `${npcId}:${e.itemId}`;
        out.set(key, {
          npcId: Number(npcId),
          npcName: v.name ?? `NPC ${npcId}`,
          faction: vendorFaction(reactions.get(npcId) ?? {}, sides.get(npcId) ?? new Set()),
          zone: zoneName(pos?.uiMap),
          x: pos?.mapX != null ? Math.round(pos.mapX * 1000) / 10 : null,
          y: pos?.mapY != null ? Math.round(pos.mapY * 1000) / 10 : null,
          uiMap: pos?.uiMap ?? null,
          itemId: e.itemId,
          stack: e.stack && e.stack > 0 ? e.stack : 1,
          costs: e.costs,
          limited: !!e.limited,
          lastSeen: v.lastSeen ?? '',
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * Price per unit. At a known standing with a recorded price, that price. Otherwise the base price
 * (Neutral or Friendly) backed out of whatever standings were recorded, which is the most Chip pays.
 */
export function vendorUnitPrice(costs: Record<string, number>, stack: number, standing?: number | null): number {
  const exact = standing != null ? costs[String(standing)] : undefined;
  const base = Math.max(...Object.entries(costs).map(([st, c]) => c / (STANDING_DISCOUNT[st] ?? 1)));
  const price = exact ?? base * (standing != null ? STANDING_DISCOUNT[String(standing)] ?? 1 : 1);
  return Math.ceil(Math.round(price) / Math.max(1, stack));
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

/** Download (cached by ETag) and merge every live build, then write vendors, loot and names into the database. */
export async function syncEgLink(db: DB, dataDir: string, log: (m: string) => void = () => {}): Promise<{ vendors: number; loot: number; names: number; builds: number }> {
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
  const lootBuilds: Parameters<typeof mergeLoot>[0] = [];
  const creatureInfo = new Map<number, { name: string; minL: number; maxL: number; cls: string; zone: string | null }>();
  const names = new Map<number, string>();
  for (const b of builds) {
    log(`eglink ${b}`);
    const [v, n, c, l, h] = await Promise.all([
      get<{ vendors: Record<string, EgVendor> }>(b, 'vendors'),
      get<{ npcs: Record<string, EgNpc> }>(b, 'npcs'),
      get<{ creatures: Record<string, EgCreature & { positions?: Pos[] }> }>(b, 'creatures'),
      get<{ sources: Record<string, EgLootSource>; kills: Record<string, EgKills> }>(b, 'loot'),
      get<{ items: Record<string, { name?: string; status?: string }> }>(b, 'item_hotfixes.enUS'),
    ]);
    vendorBuilds.push({ build: b, vendors: v?.vendors ?? {}, npcs: n?.npcs ?? {}, creatures: c?.creatures ?? {} });
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
  const vendors = mergeVendors(vendorBuilds);
  const loot = mergeLoot(lootBuilds);
  tx(db, () => {
    db.exec('DELETE FROM vendor_items');
    const iv = db.prepare(`INSERT INTO vendor_items (npc_id, npc_name, faction, zone, x, y, map_id, item_id, price, price_by_standing, units_per_purchase, limited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const v of vendors) iv.run(v.npcId, v.npcName, v.faction, v.zone, v.x, v.y, v.uiMap, v.itemId, vendorUnitPrice(v.costs, v.stack), JSON.stringify(v.costs), v.stack, v.limited ? 1 : 0);
    db.exec(`DELETE FROM loot WHERE origin = 'forever'`);
    const il = db.prepare(`INSERT OR REPLACE INTO loot (source_kind, source_id, source_name, zone, min_level, max_level, classification, item_id, chance, avg_count, kills, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'forever')`);
    for (const l of loot) {
      const kind = l.spell != null ? `${l.kind}:spell${l.spell}` : l.kind;
      const ci = l.kind === 'npc' ? creatureInfo.get(l.sourceId) : undefined;
      const name = ci?.name ?? (l.kind === 'item' ? null : l.kind === 'fishing' ? `Fishing, ${zoneName(l.sourceId) ?? l.sourceId}` : null);
      il.run(kind, l.sourceId, name, ci?.zone ?? (l.kind === 'fishing' ? zoneName(l.sourceId) : null), ci?.minL ?? null, ci?.maxL ?? null, ci?.cls ?? null,
        l.itemId, l.chance, l.perKill, l.kills, );
    }
    const un = db.prepare(`INSERT INTO items (id, name, name_source, status, fetched_at) VALUES (?, ?, 'eglink', 0, 0)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_source = 'eglink' WHERE items.name IS NULL`);
    for (const [id, name] of names) un.run(id, name);
    db.prepare(`INSERT OR REPLACE INTO datasets (name, version, fetched_at, records, note) VALUES ('eglink', ?, ?, ?, ?)`)
      .run(builds[builds.length - 1]!, Date.now(), vendors.length + loot.length, EG_ATTRIBUTION);
  });
  return { vendors: vendors.length, loot: loot.length, names: names.size, builds: builds.length };
}
