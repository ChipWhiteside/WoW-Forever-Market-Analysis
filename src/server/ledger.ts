import type { FastifyInstance } from 'fastify';
import type { DB } from '../store/db.ts';
import { getKv } from '../store/db.ts';
import { actor } from './auth.ts';

/**
 * Who did what (docs/phase2-plan.md item 6). "I did this" on a flip records units with the expected cost and profit
 * copied from the flip at that moment; "Sold" records units and gold received against it. Money in copper.
 */
interface Option { units: number; cost: number; expectedProfit: number }
interface FlipDetailLite { name?: string; itemId?: number; best: Option; options?: Option[]; perItem?: number }

/**
 * Expected cost and profit for `units` of a flip, as the card showed it. An amount on the card (small, best, most)
 * is copied exactly; any other amount is scaled from the best amount per unit.
 */
export function expectedFor(d: FlipDetailLite, units: number): { cost: number; profit: number } {
  const exact = (d.options ?? []).find(o => o.units === units);
  if (exact) return { cost: Math.round(exact.cost), profit: Math.round(exact.expectedProfit) };
  if (d.best.units > 0) return { cost: Math.round(d.best.cost * units / d.best.units), profit: Math.round(d.best.expectedProfit * units / d.best.units) };
  return { cost: 0, profit: Math.round((d.perItem ?? 0) * units) };
}

export interface ActionRow {
  id: number; action: 'did' | 'sold'; did_id: number | null; flip_key: string; username: string; at: number; units: number;
  expected_cost: number | null; expected_profit: number | null; received: number | null; item_id: number | null; name: string | null; kind: string | null; house_id: number | null;
  /** did: the inbox event it came from online (src/cloud/inbox.ts); null locally. */
  event?: string | null;
}

/**
 * Online, the cycle replays an inbox event with this header naming the event, and an "I did this" keeps it on its row.
 * A Sold saved before that "I did this" applied names it by the event (`/api/ledger/<ms>-<hex>/sold`), never by a row
 * id guessed on the site, which shifts when an earlier saved write is refused.
 */
export const EVENT_HEADER = 'x-wowf-event';
const EVENT_REF = /^\d{13}-[0-9a-f]{12}$/;
export const eventRef = (key: string) => key.slice(INBOX_PREFIX.length, -'.json'.length);
const eventOfRef = (ref: string) => EVENT_REF.test(ref) ? `${INBOX_PREFIX}${ref}.json` : null;
/** The refused inbox writes (kv inbox_refused, written by src/cloud/inbox.ts applyEvents). */
/** Where the site's saved writes live in the store. The cloud store uses the same prefix. */
export const INBOX_PREFIX = 'events/';
export const REFUSED_KV = 'inbox_refused';
/** The one reader of the refused list (kv inbox_refused). */
export const refusedList = <T extends { key: string; reason: string } = { key: string; reason: string }>(db: DB): T[] => { try { return JSON.parse(getKv(db, REFUSED_KV) ?? '[]') as T[]; } catch { return []; } };
export interface PersonTotals {
  username: string; flipsDone: number; unitsDone: number; unitsSold: number;
  spent: number; received: number; realised: number; expected: number; realisedVsExpected: number | null;
}

/**
 * Per person: flips done, gold spent (the expected cost copied at "I did this"), gold received (from Sold),
 * realised minus spent, and that against the expected profit. Unsold units count as spent and not yet received.
 */
export function ledgerTotals(rows: ActionRow[]): PersonTotals[] {
  const by = new Map<string, PersonTotals>();
  const get = (u: string) => by.get(u) ?? (by.set(u, { username: u, flipsDone: 0, unitsDone: 0, unitsSold: 0, spent: 0, received: 0, realised: 0, expected: 0, realisedVsExpected: null }), by.get(u)!);
  for (const r of rows) {
    const p = get(r.username);
    if (r.action === 'did') { p.flipsDone++; p.unitsDone += r.units; p.spent += r.expected_cost ?? 0; p.expected += r.expected_profit ?? 0; }
    else { p.unitsSold += r.units; p.received += r.received ?? 0; }
  }
  for (const p of by.values()) {
    p.realised = p.received - p.spent;
    p.realisedVsExpected = p.expected > 0 ? p.realised / p.expected : null;
  }
  return [...by.values()].sort((a, b) => b.realised - a.realised || a.username.localeCompare(b.username));
}

const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1_000_000 ? v : null;

export function registerLedgerRoutes(app: FastifyInstance, db: DB): void {
  app.post<{ Params: { key: string }; Body: { units?: unknown } }>('/api/flips/:key/did', async (req, reply) => {
    const units = posInt(req.body?.units);
    if (!units) return reply.code(400).send({ error: 'Units must be a whole number above 0.' });
    const f = db.prepare('SELECT key, kind, house_id, item_id, detail FROM flips WHERE key = ?').get(req.params.key) as { key: string; kind: string; house_id: number | null; item_id: number; detail: string } | undefined;
    if (!f) return reply.code(404).send({ error: 'No such flip.' });
    const d = JSON.parse(f.detail) as FlipDetailLite;
    const e = expectedFor(d, units);
    const ev = req.headers[EVENT_HEADER];
    const event = typeof ev === 'string' && eventOfRef(eventRef(ev)) === ev ? ev : null;
    const r = db.prepare(`INSERT INTO user_actions (action, flip_key, username, at, units, expected_cost, expected_profit, item_id, name, kind, house_id, event)
      VALUES ('did', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.key, actor(req), Date.now(), units, e.cost, e.profit, f.item_id, d.name ?? null, f.kind, f.house_id, event);
    return { ok: true, id: Number(r.lastInsertRowid), units, expectedCost: e.cost, expectedProfit: e.profit };
  });

  app.post<{ Params: { id: string }; Body: { units?: unknown; received?: unknown } }>('/api/ledger/:id/sold', async (req, reply) => {
    const units = posInt(req.body?.units);
    const received = typeof req.body?.received === 'number' && Number.isFinite(req.body.received) && req.body.received >= 0 ? Math.round(req.body.received) : null;
    if (!units || received == null) return reply.code(400).send({ error: 'Units must be a whole number above 0 and gold received 0 or more.' });
    const event = eventOfRef(req.params.id);
    const did = (event ? db.prepare(`SELECT * FROM user_actions WHERE event = ? AND action = 'did'`).get(event)
      : /^\d+$/.test(req.params.id) ? db.prepare(`SELECT * FROM user_actions WHERE id = ? AND action = 'did'`).get(Number(req.params.id)) : undefined) as ActionRow | undefined;
    if (!did) {
      const refused = event ? refusedList(db).find(x => x.key === event) : undefined;
      if (refused) return reply.code(400).send({ error: `The "I did this" it sells from was not applied (${refused.reason}).` });
      return reply.code(404).send({ error: 'No such "I did this".' });
    }
    const who = actor(req);
    if (did.username !== who) return reply.code(403).send({ error: `Only ${did.username} can mark this sold.` });
    const sold = (db.prepare(`SELECT COALESCE(SUM(units), 0) n FROM user_actions WHERE did_id = ?`).get(did.id) as { n: number }).n;
    if (sold + units > did.units) return reply.code(400).send({ error: `Only ${did.units - sold} of ${did.units} units are left to sell.` });
    const r = db.prepare(`INSERT INTO user_actions (action, did_id, flip_key, username, at, units, received, item_id, name, kind, house_id)
      VALUES ('sold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(did.id, did.flip_key, who, Date.now(), units, received, did.item_id, did.name, did.kind, did.house_id);
    return { ok: true, id: Number(r.lastInsertRowid) };
  });

  app.get('/api/ledger', async req => ledgerView(ledgerRows(db), actor(req)));
}

export const ledgerRows = (db: DB) => db.prepare('SELECT * FROM user_actions ORDER BY at DESC, id DESC').all() as unknown as ActionRow[];

/**
 * What GET /api/ledger answers for `me`, from every action row newest first. The cloud site computes it from the
 * published ledger.json (src/cloud/vercelHandler.ts), so both paths answer the same.
 */
export function ledgerView(rows: ActionRow[], me: string) {
  const soldBy = new Map<number, { units: number; received: number }>();
  for (const r of rows) if (r.action === 'sold' && r.did_id != null) {
    const s = soldBy.get(r.did_id) ?? { units: 0, received: 0 };
    s.units += r.units; s.received += r.received ?? 0; soldBy.set(r.did_id, s);
  }
  const withSold = (r: ActionRow) => r.action === 'did' ? { ...r, soldUnits: soldBy.get(r.id)?.units ?? 0, soldReceived: soldBy.get(r.id)?.received ?? 0 } : r;
  return {
    me,
    people: ledgerTotals(rows),
    // Every "I did this" of the person asking, for the Sold control on the flip card.
    mine: rows.filter(r => r.action === 'did' && r.username === me).map(withSold),
    history: rows.slice(0, 500).map(withSold),
  };
}
