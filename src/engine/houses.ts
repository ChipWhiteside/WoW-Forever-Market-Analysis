import type { BlizzardClient } from '../blizzard/client.ts';
import { HouseIndex } from '../blizzard/contracts.ts';
import type { DB } from '../store/db.ts';
import { cutFor, type Faction } from '../rules/fees.ts';

/** Ruleset in the URL is cosmetic, the house id selects the market (V16). */
export const RULESET = 2;

export function factionOf(name: string): Faction {
  if (/alliance/i.test(name)) return 'alliance';
  if (/horde/i.test(name)) return 'horde';
  return 'blackwater';
}

/**
 * Refresh the house list. Chip is Alliance, so Alliance and Blackwater houses are tracked.
 * Dead houses (no auctions, V12) are discovered at poll time and simply produce empty snapshots,
 * which health flags as suspected bugs. 112 and 118 are known dead and start untracked.
 */
export async function syncHouses(client: BlizzardClient, db: DB): Promise<number> {
  const res = await client.get(client.url(`/data/wow/ruleset/${RULESET}/auctions/`, 'dynamic'), HouseIndex);
  if (!res.body) throw new Error(`House index returned ${res.status}`);
  const KNOWN_DEAD = new Set([112, 115, 118]);
  const upsert = db.prepare(`INSERT INTO houses (id, name, faction, cut, tracked) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, faction = excluded.faction, cut = excluded.cut`);
  for (const h of res.body.auctions) {
    const f = factionOf(h.name);
    upsert.run(h.id, h.name, f, cutFor(f), f !== 'horde' && !KNOWN_DEAD.has(h.id) ? 1 : 0);
  }
  return res.body.auctions.length;
}

export interface HouseRow { id: number; name: string; faction: Faction; cut: number; tracked: number; pinned: number }
export const trackedHouses = (db: DB) => db.prepare('SELECT * FROM houses WHERE tracked = 1 ORDER BY id').all() as unknown as HouseRow[];
export const allHouses = (db: DB) => db.prepare('SELECT * FROM houses ORDER BY id').all() as unknown as HouseRow[];
