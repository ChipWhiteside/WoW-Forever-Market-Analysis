import type { BlizzardClient } from '../blizzard/client.ts';
import { ItemResponse, MediaResponse } from '../blizzard/contracts.ts';
import { type DB, tx } from '../store/db.ts';
import { BONDING_TO_BINDING, type GameData, type SparseItem } from '../datasets/gamedata.ts';

export interface ItemInfo {
  id: number; name: string | null; name_source: string | null; quality: string | null;
  item_class: string | null; item_subclass: string | null; item_level: number | null; required_level: number | null;
  binding: string | null; sell_price: number | null; purchase_price: number | null; purchase_quantity: number | null;
  max_count: number | null; stackable: number | null; media_id: number | null; icon_url: string | null; status: number; fetched_at: number;
  /** ItemSparse.Bonding (0 none, 1 pickup, 2 equip, 3 use, 4 quest); null when the game table lacks the item */
  bonding: number | null;
  /** ItemSparse.Stackable and VendorStackCount (units per vendor purchase) */
  stack_size: number | null; vendor_stack: number | null;
  /** forever | classic1x | wago | none: where name, prices and binding came from */
  data_source: string | null;
}

/** Run async jobs with bounded concurrency. Blizzard allows 100 requests a second, we stay well under. */
export async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const t = items[i++]!; await fn(t); }
  }));
}

export interface ResolveResult {
  fetched: number; notFound: number; errors: number;
  priceChanges: Array<{ id: number; from: number | null; to: number | null }>;
  /** where each resolved item's data came from this run */
  bySource: { forever: number; classic1x: number; wago: number; none: number };
  /** items fetched this run whose Blizzard data carried a binding */
  bindingFound: number;
}

const QUALITY = ['POOR', 'COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ARTIFACT', 'HEIRLOOM'];

/** The last game item table seen, so items first listed between daily refreshes still get bonding and stack sizes. */
let sparseCache: Map<number, SparseItem> | null = null;

/**
 * Fill in catalog rows for item ids we have not resolved from Blizzard yet, and refresh rows older
 * than `maxAgeMs` (vendor sell prices change with hotfixes, spec 17.3). Unnamed ids are never dropped:
 * a 404 keeps its row with status 404, and a name from EG Link hotfixes if one exists.
 *
 * Sources in order (B25): Blizzard's Forever item data; for its 404s, Blizzard's Classic item data
 * (data_source classic1x, status 200); failing both, the game's own ItemSparse row (data_source wago, status 404).
 * Binding is read from preview_item (B22). Requests are paced and 429s honour Retry-After (B26).
 */
export async function resolveItems(client: BlizzardClient, db: DB, ids: number[], opts: { maxAgeMs?: number; concurrency?: number; game?: Pick<GameData, 'items'> } = {}): Promise<ResolveResult> {
  const maxAge = opts.maxAgeMs ?? 24 * 3600_000;
  const cutoff = Date.now() - maxAge;
  const sparse = opts.game?.items ?? sparseCache;
  const existing = new Map<number, { status: number; fetched_at: number; sell_price: number | null; data_source: string | null }>();
  for (const r of db.prepare('SELECT id, status, fetched_at, sell_price, data_source FROM items').all() as unknown as Array<{ id: number; status: number; fetched_at: number; sell_price: number | null; data_source: string | null }>) existing.set(r.id, r);
  const todo = [...new Set(ids)].filter(id => {
    const e = existing.get(id);
    if (!e || e.status === 0) return true;          // never asked Blizzard
    // A Forever 404 from before the Classic fallback existed (no data_source) is asked again now, not a week later.
    if (e.status === 404) return e.data_source == null || e.fetched_at < Date.now() - 7 * 24 * 3600_000; // retry unknowns weekly
    // A row fetched before binding was read from preview_item (no data_source) is fetched once more, so its binding is real.
    if (e.status === 200 && e.data_source == null) return true;
    return e.fetched_at < cutoff;
  });
  let fetched = 0, notFound = 0, errors = 0, bindingFound = 0;
  const bySource = { forever: 0, classic1x: 0, wago: 0, none: 0 };
  const priceChanges: Array<{ id: number; from: number | null; to: number | null }> = [];
  const upsert = db.prepare(`INSERT INTO items (id, name, name_source, quality, item_class, item_subclass, item_level, required_level, binding,
      sell_price, purchase_price, purchase_quantity, max_count, stackable, media_id, status, fetched_at, data_source)
    VALUES (?, ?, 'blizzard', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_source = 'blizzard', quality = excluded.quality, item_class = excluded.item_class,
      item_subclass = excluded.item_subclass, item_level = excluded.item_level, required_level = excluded.required_level, binding = excluded.binding,
      sell_price = excluded.sell_price, purchase_price = excluded.purchase_price, purchase_quantity = excluded.purchase_quantity,
      max_count = excluded.max_count, stackable = excluded.stackable, media_id = excluded.media_id, status = 200, fetched_at = excluded.fetched_at,
      data_source = excluded.data_source`);
  // Known to neither Blizzard source: keep a name we already have (EG Link), else take the game table's.
  const upsertWago = db.prepare(`INSERT INTO items (id, name, name_source, quality, binding, sell_price, purchase_price, purchase_quantity, status, fetched_at, data_source)
    VALUES (?, ?, 'wago', ?, ?, ?, ?, ?, 404, ?, 'wago')
    ON CONFLICT(id) DO UPDATE SET name = COALESCE(items.name, excluded.name), name_source = COALESCE(items.name_source, 'wago'),
      quality = COALESCE(items.quality, excluded.quality), binding = excluded.binding, sell_price = COALESCE(items.sell_price, excluded.sell_price),
      purchase_price = COALESCE(items.purchase_price, excluded.purchase_price), purchase_quantity = COALESCE(items.purchase_quantity, excluded.purchase_quantity),
      status = 404, fetched_at = excluded.fetched_at, data_source = 'wago'`);
  const mark404 = db.prepare(`INSERT INTO items (id, status, fetched_at, data_source) VALUES (?, 404, ?, 'none')
    ON CONFLICT(id) DO UPDATE SET status = 404, fetched_at = excluded.fetched_at, data_source = 'none'`);
  const setSparse = db.prepare('UPDATE items SET bonding = ?, stack_size = ?, vendor_stack = ? WHERE id = ?');
  await pool(todo, opts.concurrency ?? 4, async id => {
    try {
      let source: 'forever' | 'classic1x' = 'forever';
      let r = await client.get(client.url(`/data/wow/item/${id}`, 'static'), ItemResponse);
      if (r.status === 404 || !r.body) {
        source = 'classic1x';
        r = await client.get(client.url(`/data/wow/item/${id}`, 'static', {}, 'classic1x'), ItemResponse);
      }
      const sp = sparse?.get(id);
      if (r.status === 404 || !r.body) {
        notFound++;
        if (sp) {
          upsertWago.run(id, sp.name || null, QUALITY[sp.quality] ?? null, BONDING_TO_BINDING[sp.bonding] ?? null, sp.sellPrice, sp.buyPrice, sp.vendorStack || null, Date.now());
          bySource.wago++;
        } else { mark404.run(id, Date.now()); bySource.none++; }
      } else {
        const b = r.body;
        const prev = existing.get(id);
        if (prev && prev.status === 200 && prev.sell_price !== (b.sell_price ?? null)) priceChanges.push({ id, from: prev.sell_price, to: b.sell_price ?? null });
        const binding = b.preview_item?.binding?.type ?? b.binding?.type ?? null;
        if (binding) bindingFound++;
        upsert.run(id, b.name, b.quality?.type ?? null, b.item_class?.name ?? null, b.item_subclass?.name ?? null, b.level ?? null,
          b.required_level ?? null, binding, b.sell_price ?? null, b.purchase_price ?? null, b.purchase_quantity ?? null,
          b.max_count ?? null, b.is_stackable == null ? null : b.is_stackable ? 1 : 0, b.media?.id ?? null, Date.now(), source);
        fetched++; bySource[source]++;
      }
      if (sp) setSparse.run(sp.bonding, sp.stackable || null, sp.vendorStack || null, id);
    } catch {
      errors++;
    }
  });
  return { fetched, notFound, errors, priceChanges, bySource, bindingFound };
}

export interface SparseCheck {
  updated: number;
  /** Blizzard binding vs ItemSparse.Bonding, on rows with Blizzard data (forever or classic1x) */
  compared: number; disagree: Array<{ id: number; blizzard: string | null; bonding: number }>;
  /** Blizzard sell price vs ItemSparse.SellPrice, on rows with Forever data only (Classic prices are another game's) */
  sellCompared: number; sellDisagree: Array<{ id: number; blizzard: number | null; sparse: number }>;
}

/**
 * Copy bonding, stack size and vendor bundle size from the game's item table onto every catalog row it knows,
 * and cross check Blizzard's binding (B23) and sell price against ItemSparse where both exist. The binding column
 * keeps Blizzard's words (ON_ACQUIRE and so on), so the bind on pickup guards read it as before. Run it after the
 * vendor price refresh, so the live API side is today's: a server hotfix shows up as a disagreement here.
 */
export function applyItemSparse(db: DB, game: Pick<GameData, 'items'>): SparseCheck {
  sparseCache = game.items;
  const rows = db.prepare('SELECT id, binding, sell_price, data_source, status FROM items').all() as Array<{ id: number; binding: string | null; sell_price: number | null; data_source: string | null; status: number }>;
  const set = db.prepare('UPDATE items SET bonding = ?, stack_size = ?, vendor_stack = ? WHERE id = ?');
  let updated = 0, compared = 0, sellCompared = 0;
  const disagree: SparseCheck['disagree'] = [];
  const sellDisagree: SparseCheck['sellDisagree'] = [];
  tx(db, () => {
    for (const r of rows) {
      const sp = game.items.get(r.id);
      if (!sp) continue;
      set.run(sp.bonding, sp.stackable || null, sp.vendorStack || null, r.id);
      updated++;
      if (r.status === 200 && (r.data_source === 'forever' || r.data_source === 'classic1x')) {
        compared++;
        if ((BONDING_TO_BINDING[sp.bonding] ?? null) !== r.binding) disagree.push({ id: r.id, blizzard: r.binding, bonding: sp.bonding });
      }
      if (r.status === 200 && r.data_source === 'forever') {
        sellCompared++;
        if ((r.sell_price ?? 0) !== sp.sellPrice) sellDisagree.push({ id: r.id, blizzard: r.sell_price, sparse: sp.sellPrice });
      }
    }
  });
  return { updated, compared, disagree, sellCompared, sellDisagree };
}

export interface TradeVerdict { tradeable: boolean; by: 'listed' | 'api' | 'itemsparse' | 'none'; reason: string | null }

/** The last verdicts computed, so the flip gate (which has no database) reads the same answer. */
let tradeCache: Map<number, TradeVerdict> | null = null;

/**
 * Can an item reach an auction house right now? One answer for the flip engine and the conversion filter.
 * 1. Listed on a tracked house in the last 24 hours: tradeable, whatever any field says. Market evidence wins
 *    (Blinding Powder 5530 is Bonding 1 in ItemSparse yet listed by the thousand).
 * 2. Else, with Forever item data (data_source forever): the Forever API binding decides. ON_ACQUIRE or QUEST blocks.
 * 3. Else ItemSparse Bonding 1 (pickup) or 4 (quest) blocks.
 * Blizzard's Classic binding (data_source classic1x) alone never blocks: it describes another game.
 * Items in neither the catalog nor a listing are absent from the map; callers decide (the conversion filter treats
 * them as bound).
 */
export function itemTradeable(db: DB, now = Date.now()): Map<number, TradeVerdict> {
  const out = new Map<number, TradeVerdict>();
  for (const r of db.prepare(`SELECT DISTINCT item_id FROM item_stats WHERE listings > 0 AND published_at >= ? AND house_id IN (SELECT id FROM houses WHERE tracked = 1)`)
    .all(now - 24 * 3600_000) as Array<{ item_id: number }>) out.set(r.item_id, { tradeable: true, by: 'listed', reason: null });
  for (const r of db.prepare('SELECT id, binding, bonding, data_source, status FROM items').all() as Array<{ id: number; binding: string | null; bonding: number | null; data_source: string | null; status: number }>) {
    if (out.has(r.id)) continue;
    if (r.status === 200 && r.data_source === 'forever') {
      out.set(r.id, r.binding === 'ON_ACQUIRE' ? { tradeable: false, by: 'api', reason: 'binds on pickup, it cannot be sold on an auction house' }
        : r.binding === 'QUEST' ? { tradeable: false, by: 'api', reason: 'a quest item, it cannot be sold on an auction house' }
        : { tradeable: true, by: 'api', reason: null });
      continue;
    }
    out.set(r.id, r.bonding === 1 ? { tradeable: false, by: 'itemsparse', reason: 'binds on pickup, it cannot be sold on an auction house' }
      : r.bonding === 4 ? { tradeable: false, by: 'itemsparse', reason: 'a quest item, it cannot be sold on an auction house' }
      : { tradeable: true, by: r.bonding == null ? 'none' : 'itemsparse', reason: null });
  }
  tradeCache = out;
  return out;
}

/**
 * Why an item cannot be listed, or null. Reads the verdicts from the last itemTradeable run; before any run (the
 * flip CLI), falls back to the item's own fields: Blizzard binding or ItemSparse bonding, pickup or quest.
 */
export function tradeBlock(it: { id: number; binding: string | null; bonding: number | null } | undefined): string | null {
  if (!it) return null;
  const v = tradeCache?.get(it.id);
  if (v) return v.reason;
  if (it.binding === 'ON_ACQUIRE' || it.bonding === 1) return 'binds on pickup, it cannot be sold on an auction house';
  if (it.binding === 'QUEST' || it.bonding === 4) return 'a quest item, it cannot be sold on an auction house';
  return null;
}

/** Resolve icon urls for items that have a media id but no icon yet. */
export async function resolveIcons(client: BlizzardClient, db: DB, limit = 2000): Promise<number> {
  const rows = db.prepare('SELECT id, media_id FROM items WHERE media_id IS NOT NULL AND icon_url IS NULL LIMIT ?').all(limit) as Array<{ id: number; media_id: number }>;
  let n = 0;
  const set = db.prepare('UPDATE items SET icon_url = ? WHERE id = ?');
  await pool(rows, 4, async r => {
    try {
      const m = await client.get(client.url(`/data/wow/media/item/${r.media_id}`, 'static'), MediaResponse);
      const icon = m.body?.assets?.find(a => a.key === 'icon')?.value;
      if (icon) { set.run(icon, r.id); n++; }
    } catch { /* placeholder icon in the app */ }
  });
  return n;
}

export function getItem(db: DB, id: number): ItemInfo | null {
  return (db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemInfo) ?? null;
}

export function itemName(i: ItemInfo | null | undefined, id: number): string {
  return i?.name ?? `Item ${id}`;
}
