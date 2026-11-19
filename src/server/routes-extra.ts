import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from './server.ts';
import { priceBook } from '../analysis/prices.ts';
import { craftBoard, Crafter } from '../craft/makeOrBuy.ts';
import { sourceBoard } from '../drops/value.ts';
import { marketReport } from '../market/report.ts';
import { itemValue } from '../drops/value.ts';
import { calibration } from '../analysis/calibration.ts';
import { levelingPlan } from '../craft/leveling.ts';
import { parseInventoryLine } from '../craft/inventory.ts';
import { demandByItem } from '../analysis/history.ts';
import { primaryHouse } from '../analysis/prices.ts';

const professionsSetting = (deps: ServerDeps): Record<string, number> | null => {
  const r = deps.db.prepare(`SELECT value FROM settings WHERE key = 'professions'`).get() as { value: string } | undefined;
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
};

export function registerExtraRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { db } = deps;

  app.get<{ Querystring: { profession?: string } }>('/api/crafting', async req => {
    const book = priceBook(db);
    const professions = professionsSetting(deps);
    const house = primaryHouse(db);
    const share = Number((db.prepare(`SELECT value FROM settings WHERE key = 'sell_share'`).get() as { value: string } | undefined)?.value ?? 0.2);
    const rows = craftBoard(db, book, { professions, profession: req.query.profession || undefined, demand: house ? demandByItem(db, house.id) : undefined, sellShare: share });
    const profs = db.prepare('SELECT profession, COUNT(*) n FROM recipes GROUP BY profession ORDER BY profession').all();
    return { house: book.houseName, professions, profs, rows: rows.slice(0, 400) };
  });
  app.get<{ Params: { id: string } }>('/api/crafting/:id', async req => {
    const book = priceBook(db);
    const c = new Crafter(db, book);
    const r = c.recipes.find(x => x.id === Number(req.params.id));
    if (!r) return { error: 'no such recipe' };
    return { recipe: r, tree: c.tree(r), cost: c.craftCost(r) };
  });

  app.get<{ Querystring: { min?: string; max?: string; kind?: string; thin?: string } }>('/api/drops', async req => {
    const book = priceBook(db);
    const rows = sourceBoard(db, book, { minLevel: req.query.min ? Number(req.query.min) : undefined, maxLevel: req.query.max ? Number(req.query.max) : undefined, kind: req.query.kind || undefined, minKills: req.query.thin === '1' ? 0 : undefined });
    return { house: book.houseName, rows: rows.slice(0, 300) };
  });

  app.get('/api/market', async () => marketReport(db));

  // Leveling plan from the guide, using Chip's materials first.
  app.get<{ Querystring: { profession?: string; from?: string; to?: string } }>('/api/leveling', async req => {
    const profession = req.query.profession || 'Blacksmithing';
    const current = professionsSetting(deps)?.[profession] ?? 1;
    const from = Number(req.query.from || current), to = Number(req.query.to || Math.min(300, Math.max(from + 25, 150)));
    return { ...levelingPlan(db, priceBook(db), profession, from, to), current };
  });

  // Chip's materials. PUT one item, or POST a pasted list of "name count" lines.
  app.get('/api/inventory', async () => db.prepare(`SELECT v.item_id, v.count, i.name, i.icon_url, i.quality FROM inventory v LEFT JOIN items i ON i.id = v.item_id ORDER BY i.name`).all());
  app.put<{ Body: { itemId: number; count: number } }>('/api/inventory', async req => {
    if (req.body.count > 0) db.prepare('INSERT INTO inventory (item_id, count, updated_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at').run(req.body.itemId, Math.round(req.body.count), Date.now());
    else db.prepare('DELETE FROM inventory WHERE item_id = ?').run(req.body.itemId);
    return { ok: true };
  });
  app.post<{ Body: { text: string } }>('/api/inventory/paste', async req => {
    const added: string[] = [], unknown: string[] = [];
    for (const line of req.body.text.split(/\r?\n/)) {
      const parsed = parseInventoryLine(line);
      if (!parsed) { if (line.trim()) unknown.push(line.trim()); continue; }
      const it = db.prepare('SELECT id, name FROM items WHERE lower(name) = lower(?)').get(parsed.name) as { id: number; name: string } | undefined;
      if (!it) { unknown.push(parsed.name); continue; }
      db.prepare('INSERT INTO inventory (item_id, count, updated_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at').run(it.id, parsed.count, Date.now());
      added.push(`${parsed.count} ${it.name}`);
    }
    return { added, unknown };
  });
  app.get('/api/calibration', async () => calibration(db));

  // Positions
  app.get('/api/positions', async () => {
    const book = priceBook(db);
    const rows = db.prepare(`SELECT p.*, i.name, i.quality, i.icon_url FROM positions p LEFT JOIN items i ON i.id = p.item_id ORDER BY p.closed_at IS NOT NULL, p.opened_at DESC`).all() as Array<Record<string, any>>;
    const start = Number((db.prepare(`SELECT value FROM settings WHERE key = 'starting_gold'`).get() as { value: string } | undefined)?.value ?? 0);
    let tied = 0, realized = 0;
    const out = rows.map(r => {
      const held = r.quantity - (r.sold_qty ?? 0);
      const v = itemValue(book, r.item_id);
      if (!r.closed_at) tied += held * r.unit_cost;
      if (r.sold_qty) realized += r.sold_qty * ((r.unit_sale ?? 0) - r.unit_cost);
      return { ...r, held, valueNow: v.value, worthNow: held * v.value, how: v.how };
    });
    return { rows: out, startingGold: start, tied, realized, available: start - tied + realized };
  });
  app.post<{ Body: { itemId: number; quantity: number; unitCost: number; houseId?: number; note?: string } }>('/api/positions', async req => {
    db.prepare('INSERT INTO positions (item_id, house_id, quantity, unit_cost, opened_at, note) VALUES (?, ?, ?, ?, ?, ?)').run(req.body.itemId, req.body.houseId ?? null, req.body.quantity, req.body.unitCost, Date.now(), req.body.note ?? null);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { soldQty: number; unitSale: number } }>('/api/positions/:id/sell', async req => {
    const p = db.prepare('SELECT quantity, sold_qty FROM positions WHERE id = ?').get(Number(req.params.id)) as { quantity: number; sold_qty: number | null } | undefined;
    if (!p) return { error: 'no such position' };
    const sold = (p.sold_qty ?? 0) + req.body.soldQty;
    db.prepare('UPDATE positions SET sold_qty = ?, unit_sale = ?, closed_at = CASE WHEN ? >= quantity THEN ? ELSE NULL END WHERE id = ?').run(sold, req.body.unitSale, sold, Date.now(), Number(req.params.id));
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/positions/:id', async req => { db.prepare('DELETE FROM positions WHERE id = ?').run(Number(req.params.id)); return { ok: true }; });

  // Watchlist
  app.get('/api/watchlist', async () => {
    const book = priceBook(db);
    return (db.prepare(`SELECT w.*, i.name, i.quality, i.icon_url, i.sell_price FROM watchlist w LEFT JOIN items i ON i.id = w.item_id ORDER BY w.added_at DESC`).all() as Array<Record<string, any>>)
      .map(w => ({ ...w, floor: book.floor.get(w.item_id)?.floor ?? null, units: book.floor.get(w.item_id)?.units ?? 0 }));
  });
  app.post<{ Body: { itemId: number; alertAbove?: number | null; alertBelow?: number | null } }>('/api/watchlist', async req => {
    db.prepare(`INSERT INTO watchlist (item_id, alert_above, alert_below, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET alert_above = excluded.alert_above, alert_below = excluded.alert_below`)
      .run(req.body.itemId, req.body.alertAbove ?? null, req.body.alertBelow ?? null, Date.now());
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/watchlist/:id', async req => { db.prepare('DELETE FROM watchlist WHERE item_id = ?').run(Number(req.params.id)); return { ok: true }; });

  // Farming sessions: start, then end with what was gathered. Gold per hour at today's prices.
  app.get('/api/farming', async () => {
    const book = priceBook(db);
    const rows = db.prepare('SELECT * FROM farm_sessions ORDER BY started_at DESC LIMIT 100').all() as Array<Record<string, any>>;
    return rows.map(r => {
      const items: Array<{ itemId: number; count: number }> = r.items ? JSON.parse(r.items) : [];
      const hours = ((r.ended_at ?? Date.now()) - r.started_at) / 3600_000;
      const value = items.reduce((s, it) => s + it.count * itemValue(book, it.itemId).value, 0);
      return { ...r, items: items.map(it => ({ ...it, name: book.names.get(it.itemId) ?? `Item ${it.itemId}`, perHour: hours ? it.count / hours : 0 })), hours, value, goldPerHour: hours > 0 && r.ended_at ? value / hours : null };
    });
  });
  app.post<{ Body: { activity: string } }>('/api/farming/start', async req => {
    const r = db.prepare('INSERT INTO farm_sessions (activity, started_at) VALUES (?, ?)').run(req.body.activity, Date.now());
    return { id: Number(r.lastInsertRowid) };
  });
  app.post<{ Params: { id: string }; Body: { items: Array<{ itemId: number; count: number }>; endedAt?: number } }>('/api/farming/:id/end', async req => {
    db.prepare('UPDATE farm_sessions SET ended_at = ?, items = ? WHERE id = ?').run(req.body.endedAt ?? Date.now(), JSON.stringify(req.body.items), Number(req.params.id));
    return { ok: true };
  });
}
