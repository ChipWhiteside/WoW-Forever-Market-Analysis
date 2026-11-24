import type { DB } from '../store/db.ts';
import { cutFor, type Faction } from '../rules/fees.ts';
import { DEFAULT_HOUSE } from '../rules/flips.ts';
import type { HouseRef } from './types.ts';

/**
 * Chip's houses, and no other (decision 3): his pinned Alliance house, else 111, plus his one pinned Blackwater house
 * when he has pinned it. At most one of each; with two pinned of a faction the lowest id wins and `notes` says so.
 * A pinned Horde house is ignored. Every other house is never read for flips.
 */
export function chipHouses(db: DB): HouseRef[] {
  return chipHousesWithNotes(db).houses;
}

export function chipHousesWithNotes(db: DB): { houses: HouseRef[]; notes: string[] } {
  const notes: string[] = [];
  const rows = db.prepare('SELECT id, name, faction, cut, pinned FROM houses ORDER BY id').all() as Array<{ id: number; name: string; faction: Faction; cut: number; pinned: number }>;
  const pub = new Map((db.prepare('SELECT house_id, MAX(published_at) t FROM snapshots GROUP BY house_id').all() as Array<{ house_id: number; t: number }>).map(r => [r.house_id, r.t]));
  const ref = (r: { id: number; name: string; faction: Faction }): HouseRef => ({ id: r.id, name: r.name, faction: r.faction, cut: cutFor(r.faction), publishedAt: pub.get(r.id) ?? 0 });
  const pick = (faction: Faction) => {
    const p = rows.filter(r => r.pinned && r.faction === faction);
    if (p.length > 1) notes.push(`${p.length} ${faction} houses are pinned (${p.map(r => r.id).join(', ')}), using ${p[0]!.id}`);
    return p[0];
  };
  const out: HouseRef[] = [];
  const alliance = pick('alliance') ?? rows.find(r => r.id === DEFAULT_HOUSE) ?? { id: DEFAULT_HOUSE, name: 'Alliance Auction House', faction: 'alliance' as Faction };
  out.push(ref(alliance));
  const blackwater = pick('blackwater');
  if (blackwater) out.push(ref(blackwater));
  else notes.push('no Blackwater house pinned yet, flips run on the Alliance house alone');
  return { houses: out, notes };
}
