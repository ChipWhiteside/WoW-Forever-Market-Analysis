import type { DB } from '../store/db.ts';
import { readingsSoFar } from '../analysis/history.ts';

export interface PlayRow {
  key: string; detector: string; house_id: number; house_name: string; faction: string; item_id: number; item_name: string | null;
  quality: string | null; icon_url: string | null; state: string; profit: number; peak_profit: number; confidence: string; summary: string;
  detail: unknown; first_seen: number; last_seen: number; data_at: number; snapshots_seen: number; gone_at: number | null; user_status: string | null;
}

export function listPlays(db: DB, f: { detector?: string[]; house?: number; includeGone?: boolean; limit?: number } = {}): PlayRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (f.detector?.length) { where.push(`p.detector IN (${f.detector.map(() => '?').join(',')})`); args.push(...f.detector); }
  if (f.house) { where.push('p.house_id = ?'); args.push(f.house); }
  if (!f.includeGone) where.push(`p.state != 'gone'`);
  where.push(`(p.user_status IS NULL OR p.user_status = 'done')`);
  const rows = db.prepare(`SELECT p.*, h.name house_name, h.faction, i.name item_name, i.quality, i.icon_url
    FROM plays p JOIN houses h ON h.id = p.house_id LEFT JOIN items i ON i.id = p.item_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (p.state = 'gone'), p.profit DESC LIMIT ?`).all(...args, f.limit ?? 300) as unknown as Array<PlayRow & { detail: string }>;
  return rows.map(r => ({ ...r, detail: JSON.parse(r.detail) }));
}

export function houseFinder(db: DB) {
  const markers = [[2770, 'Copper Ore'], [2589, 'Linen Cloth'], [2592, 'Wool Cloth'], [2840, 'Copper Bar']] as const;
  const houses = db.prepare('SELECT id, name, faction, pinned FROM houses WHERE tracked = 1 ORDER BY faction, id').all() as Array<{ id: number; name: string; faction: string; pinned: number }>;
  const q = db.prepare(`SELECT floor, units_at_floor, total_units, published_at FROM item_stats WHERE house_id = ? AND item_id = ? ORDER BY published_at DESC LIMIT 1`);
  const size = db.prepare(`SELECT SUM(rows) rows, MAX(published_at) t FROM snapshots WHERE house_id = ? AND published_at = (SELECT MAX(published_at) FROM snapshots s2 WHERE s2.house_id = ? AND s2.kind = snapshots.kind)`);
  return houses.map(h => ({
    ...h,
    ...(size.get(h.id, h.id) as { rows: number | null; t: number | null }),
    markers: markers.map(([id, name]) => ({ id, name, ...(q.get(h.id, id) as object | undefined ?? { floor: null }) })),
  }));
}

export function itemDetail(db: DB, id: number) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) ?? { id, name: null };
  const houses = db.prepare(`SELECT h.id, h.name, h.faction, h.pinned, s.floor, s.units_at_floor, s.units_within5, s.total_units, s.listings, s.ladder, s.published_at
    FROM houses h JOIN item_stats s ON s.house_id = h.id
    WHERE h.tracked = 1 AND s.item_id = ? AND s.published_at = (SELECT MAX(published_at) FROM item_stats s2 WHERE s2.house_id = h.id AND s2.item_id = ?)
    ORDER BY h.pinned DESC, h.id`).all(id, id) as Array<Record<string, unknown> & { ladder: string }>;
  const history = db.prepare(`SELECT house_id, published_at t, floor, total_units FROM item_stats WHERE item_id = ? AND published_at > ? AND floor IS NOT NULL ORDER BY published_at`)
    .all(id, Date.now() - 7 * 86_400_000);
  const vendors = db.prepare(`SELECT npc_id, npc_name, faction, zone, x, y, map_id, price, price_by_standing, units_per_purchase, limited FROM vendor_items WHERE item_id = ? ORDER BY faction = 'horde', price`).all(id);
  const madeBy = db.prepare(`SELECT r.*, (SELECT json_group_array(json_object('item_id', g.item_id, 'quantity', g.quantity, 'name', i.name)) FROM recipe_reagents g LEFT JOIN items i ON i.id = g.item_id WHERE g.recipe_id = r.id) reagents
    FROM recipes r WHERE r.crafted_item_id = ?`).all(id);
  const usedIn = db.prepare(`SELECT r.id, r.name, r.profession, r.crafted_item_id, g.quantity FROM recipe_reagents g JOIN recipes r ON r.id = g.recipe_id WHERE g.item_id = ? ORDER BY r.profession, r.yellow LIMIT 60`).all(id);
  const drops = db.prepare(`SELECT * FROM loot WHERE item_id = ? ORDER BY kills >= 10 DESC, chance DESC LIMIT 40`).all(id);
  const quests = db.prepare(`SELECT MIN(quest_id) quest_id, title, MAX(amount) amount, MIN(level) level, MIN(min_level) min_level FROM quest_items WHERE item_id = ? GROUP BY title ORDER BY level`).all(id);
  return { item, houses: houses.map(h => ({ ...h, ladder: JSON.parse(h.ladder) })), history, vendors, madeBy, usedIn, drops, quests };
}

export function searchItems(db: DB, q: string, limit = 20) {
  if (/^\d+$/.test(q)) return db.prepare('SELECT id, name, quality, icon_url FROM items WHERE id = ?').all(Number(q));
  return db.prepare(`SELECT i.id, i.name, i.quality, i.icon_url FROM items i WHERE i.name LIKE ? ORDER BY (i.name LIKE ?) DESC,
    (SELECT COUNT(*) FROM item_stats s WHERE s.item_id = i.id AND s.published_at > ?) DESC, length(i.name) LIMIT ?`)
    .all(`%${q}%`, `${q}%`, Date.now() - 3 * 3600_000, limit);
}

export function overview(db: DB) {
  const counts = db.prepare(`SELECT detector, COUNT(*) n, SUM(CASE WHEN confidence != 'low' THEN profit ELSE 0 END) profit, SUM(state = 'new') fresh FROM plays WHERE state != 'gone' AND user_status IS NULL GROUP BY detector`).all();
  const pinned = db.prepare('SELECT id, name, faction FROM houses WHERE pinned = 1').all() as Array<{ id: number; name: string; faction: string }>;
  const learning = pinned.length ? pinned.map(h => ({ house: h.id, readings: readingsSoFar(db, h.id) })) : [];
  const datasets = db.prepare('SELECT * FROM datasets').all();
  const totals = db.prepare('SELECT COUNT(*) snapshots, MIN(published_at) first FROM snapshots').get();
  const items = db.prepare(`SELECT COUNT(*) n, SUM(status = 200) blizzard, SUM(name IS NOT NULL) named FROM items`).get();
  const news = (db.prepare(`SELECT value FROM kv WHERE key = 'news:vendor_price_changes'`).get() as { value: string } | undefined)?.value;
  const cc = (db.prepare(`SELECT value FROM kv WHERE key = 'closest_calls'`).get() as { value: string } | undefined)?.value;
  let closest = null;
  if (cc) {
    const parsed = JSON.parse(cc) as { at: number; minEach: number; calls: Array<{ itemId: number; [k: string]: unknown }> };
    const nameQ = db.prepare('SELECT name, quality, icon_url FROM items WHERE id = ?');
    closest = { ...parsed, calls: parsed.calls.map(c => ({ ...c, ...(nameQ.get(c.itemId) as object ?? {}) })) };
  }
  return { counts, pinned, learning, datasets, totals, items, news: news ? JSON.parse(news) : null, closest };
}
