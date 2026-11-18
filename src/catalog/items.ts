import type { BlizzardClient } from '../blizzard/client.ts';
import { ItemResponse, MediaResponse } from '../blizzard/contracts.ts';
import type { DB } from '../store/db.ts';

export interface ItemInfo {
  id: number; name: string | null; name_source: string | null; quality: string | null;
  item_class: string | null; item_subclass: string | null; item_level: number | null; required_level: number | null;
  binding: string | null; sell_price: number | null; purchase_price: number | null; purchase_quantity: number | null;
  max_count: number | null; stackable: number | null; media_id: number | null; icon_url: string | null; status: number; fetched_at: number;
}

/** Run async jobs with bounded concurrency. Blizzard allows 100 requests a second, we stay well under. */
export async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const t = items[i++]!; await fn(t); }
  }));
}

/**
 * Fill in catalog rows for item ids we have not resolved from Blizzard yet, and refresh rows older
 * than `maxAgeMs` (vendor sell prices change with hotfixes, spec 17.3). Unnamed ids are never dropped:
 * a 404 keeps its row with status 404, and a name from EG Link hotfixes if one exists.
 */
export async function resolveItems(client: BlizzardClient, db: DB, ids: number[], opts: { maxAgeMs?: number; concurrency?: number } = {}): Promise<{ fetched: number; notFound: number; errors: number; priceChanges: Array<{ id: number; from: number | null; to: number | null }> }> {
  const maxAge = opts.maxAgeMs ?? 24 * 3600_000;
  const cutoff = Date.now() - maxAge;
  const existing = new Map<number, { status: number; fetched_at: number; sell_price: number | null }>();
  for (const r of db.prepare('SELECT id, status, fetched_at, sell_price FROM items').all() as unknown as Array<{ id: number; status: number; fetched_at: number; sell_price: number | null }>) existing.set(r.id, r);
  const todo = [...new Set(ids)].filter(id => {
    const e = existing.get(id);
    if (!e || e.status === 0) return true;          // never asked Blizzard
    if (e.status === 404) return e.fetched_at < Date.now() - 7 * 24 * 3600_000; // retry unknowns weekly
    return e.fetched_at < cutoff;
  });
  let fetched = 0, notFound = 0, errors = 0;
  const priceChanges: Array<{ id: number; from: number | null; to: number | null }> = [];
  const upsert = db.prepare(`INSERT INTO items (id, name, name_source, quality, item_class, item_subclass, item_level, required_level, binding,
      sell_price, purchase_price, purchase_quantity, max_count, stackable, media_id, status, fetched_at)
    VALUES (?, ?, 'blizzard', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_source = 'blizzard', quality = excluded.quality, item_class = excluded.item_class,
      item_subclass = excluded.item_subclass, item_level = excluded.item_level, required_level = excluded.required_level, binding = excluded.binding,
      sell_price = excluded.sell_price, purchase_price = excluded.purchase_price, purchase_quantity = excluded.purchase_quantity,
      max_count = excluded.max_count, stackable = excluded.stackable, media_id = excluded.media_id, status = 200, fetched_at = excluded.fetched_at`);
  const mark404 = db.prepare(`INSERT INTO items (id, status, fetched_at) VALUES (?, 404, ?) ON CONFLICT(id) DO UPDATE SET status = 404, fetched_at = excluded.fetched_at`);
  await pool(todo, opts.concurrency ?? 16, async id => {
    try {
      const r = await client.get(client.url(`/data/wow/item/${id}`, 'static'), ItemResponse);
      if (r.status === 404 || !r.body) { mark404.run(id, Date.now()); notFound++; return; }
      const b = r.body;
      const prev = existing.get(id);
      if (prev && prev.status === 200 && prev.sell_price !== (b.sell_price ?? null)) priceChanges.push({ id, from: prev.sell_price, to: b.sell_price ?? null });
      upsert.run(id, b.name, b.quality?.type ?? null, b.item_class?.name ?? null, b.item_subclass?.name ?? null, b.level ?? null,
        b.required_level ?? null, b.binding?.type ?? null, b.sell_price ?? null, b.purchase_price ?? null, b.purchase_quantity ?? null,
        b.max_count ?? null, b.is_stackable == null ? null : b.is_stackable ? 1 : 0, b.media?.id ?? null, Date.now());
      fetched++;
    } catch {
      errors++;
    }
  });
  return { fetched, notFound, errors, priceChanges };
}

/** Resolve icon urls for items that have a media id but no icon yet. */
export async function resolveIcons(client: BlizzardClient, db: DB, limit = 2000): Promise<number> {
  const rows = db.prepare('SELECT id, media_id FROM items WHERE media_id IS NOT NULL AND icon_url IS NULL LIMIT ?').all(limit) as Array<{ id: number; media_id: number }>;
  let n = 0;
  const set = db.prepare('UPDATE items SET icon_url = ? WHERE id = ?');
  await pool(rows, 16, async r => {
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
