import { randomBytes } from 'node:crypto';
import type { DB } from '../store/db.ts';
import { getKv, setKv } from '../store/db.ts';
import { buildServer } from '../server/server.ts';
import { makeAuth, COOKIE } from '../server/auth.ts';
import { ledgerRows, type ActionRow } from '../server/ledger.ts';
import type { BlobStore } from './store.ts';
import { INBOX_PREFIX } from './githubStore.ts';

/**
 * The site's writes (brief item 4). The site never writes the database: each write (I did this, Sold, settings, house
 * pins, any other write route) is first tried on the site's own copy inside a transaction that is rolled back, so a
 * refusal answers at once, then saved as one sealed event file. The hourly cycle replays the events through the same
 * routes, in name order, so the routes stay the one owner of what a write does.
 *
 * Names are `events/<ms>-<random>.json`: time first so they sort, never the username (the repository is public).
 * Applied names are kept in kv `inbox_applied`, so an event whose delete failed is never applied twice.
 */
export interface InboxEvent { v: 1; at: number; user: string; method: string; url: string; contentType: string | null; body: string }
export const APPLIED_KV = 'inbox_applied';
const APPLIED_KEEP = 2000;

export const eventKey = (at = Date.now()) => `${INBOX_PREFIX}${String(at).padStart(13, '0')}-${randomBytes(6).toString('hex')}.json`;

export async function addEvent(store: BlobStore, ev: Omit<InboxEvent, 'v'>): Promise<string> {
  if (!ev.url.startsWith('/api/')) throw new Error(`not an api write: ${ev.url}`);
  const key = eventKey(ev.at);
  await store.put(key, new TextEncoder().encode(JSON.stringify({ v: 1, ...ev })), 'application/json');
  return key;
}

/** Every event waiting, oldest first. One that cannot be read (a wrong key, a changed file) is returned as bad. */
export async function readEvents(store: BlobStore): Promise<Array<{ key: string; ev: InboxEvent | null; error?: string }>> {
  const out: Array<{ key: string; ev: InboxEvent | null; error?: string }> = [];
  for (const o of await store.list(INBOX_PREFIX)) {
    if (!o.key.endsWith('.json')) continue;
    try {
      const got = await store.get(o.key);
      if (got) out.push({ key: o.key, ev: JSON.parse(new TextDecoder().decode(got.body)) as InboxEvent });
    } catch (e) { out.push({ key: o.key, ev: null, error: (e as Error).message }); }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export const appliedKeys = (db: DB): string[] => { try { return JSON.parse(getKv(db, APPLIED_KV) ?? '[]') as string[]; } catch { return []; } };

export interface ApplyResult { applied: Array<{ key: string; status: number; error?: string }>; skipped: number }

/**
 * Replay events on the cycle's database through the existing routes, signed in as the event's user. Each is applied
 * once: a name already in `inbox_applied` is skipped. A route that refuses (a Sold for more units than are left,
 * because two people raced) or an event that cannot be read counts as done, so it never blocks the queue, and is
 * kept in kv `inbox_refused` with its reason, so ledger.json and the Ledger page say "not applied: <reason>".
 * Actions logs are public, so the log says counts only: never an event's name, path, flip, item, house or person.
 */
export async function applyEvents(db: DB, events: Array<{ key: string; ev: InboxEvent | null; error?: string }>, log: (m: string) => void): Promise<ApplyResult> {
  const done = appliedKeys(db);
  const seen = new Set(done);
  const out: ApplyResult = { applied: [], skipped: 0 };
  const fresh = events.filter(e => { if (seen.has(e.key)) { out.skipped++; return false; } return true; });
  if (!fresh.length) { if (out.skipped) log(`inbox: ${out.skipped} already applied, skipped`); return out; }
  const auth = { password: null, secret: randomBytes(32).toString('hex') };
  const sign = makeAuth(auth);
  const app = buildServer({ db, engine: null, client: null, port: 0, dataDir: '', auth });
  const refused = refusedActions(db);
  try {
    for (const { key, ev, error } of fresh) {
      let reason: string | null = null;
      if (!ev) { reason = error ?? 'unreadable'; out.applied.push({ key, status: 0, error: reason }); }
      else {
        const r = await app.inject(eventRequest(ev, sign.sign(ev.user)));
        if (r.statusCode >= 400) reason = errorText(r.body, r.statusCode);
        out.applied.push({ key, status: r.statusCode, ...(reason ? { error: reason } : {}) });
      }
      if (reason) {
        const [p] = ev ? pendingActions([{ key, ev }], [], nameIn(db)) : [];
        refused.push({ ...(p ?? { key, at: Date.now(), username: 'unknown', action: 'other', flipKey: null, didId: null, units: null, received: null, name: null, what: 'A saved change' }), reason });
      }
      done.push(key);
      setKv(db, APPLIED_KV, JSON.stringify(done.slice(-APPLIED_KEEP)));
    }
  } finally { await app.close(); }
  setKv(db, REFUSED_KV, JSON.stringify(refused.slice(-REFUSED_KEEP)));
  const bad = out.applied.filter(a => a.status === 0 || a.status >= 400).length;
  log(`inbox: ${out.applied.length - bad} applied, ${bad} not applied${out.skipped ? `, ${out.skipped} already applied` : ''}`);
  return out;
}

/** An inbox event as an inject request, signed in as the person who saved it: the cycle and the site replay alike. */
export const eventRequest = (ev: InboxEvent, token: string) => ({
  method: ev.method as 'POST', url: ev.url,
  headers: { cookie: `${COOKIE}=${encodeURIComponent(token)}`, ...(ev.contentType ? { 'content-type': ev.contentType } : {}) },
  ...(ev.body ? { payload: ev.body } : {}),
});

/** A route's refusal in words: its JSON error, else the start of its body. */
function errorText(body: string, status: number): string {
  try { const e = (JSON.parse(body) as { error?: unknown }).error; if (typeof e === 'string' && e) return e.slice(0, 200); } catch { /* not JSON */ }
  return body.slice(0, 200) || `answered ${status}`;
}

/** Names for a refused event: the flip's from the flips table, the "I did this" row's from user_actions. */
const nameIn = (db: DB) => (flipKey: string | null, didId: number | null): string | null => {
  if (flipKey) {
    const r = db.prepare('SELECT detail FROM flips WHERE key = ?').get(flipKey) as { detail: string } | undefined;
    try { return r ? (JSON.parse(r.detail) as { name?: string }).name ?? null : null; } catch { return null; }
  }
  if (didId != null) return (db.prepare('SELECT name FROM user_actions WHERE id = ?').get(didId) as { name: string | null } | undefined)?.name ?? null;
  return null;
};

/** A saved write the cycle could not apply, with the reason. Newest last. */
export interface RefusedAction extends PendingAction { reason: string }
export const REFUSED_KV = 'inbox_refused';
const REFUSED_KEEP = 50;
export const refusedActions = (db: DB): RefusedAction[] => { try { return JSON.parse(getKv(db, REFUSED_KV) ?? '[]') as RefusedAction[]; } catch { return []; } };

/** ledger.json: every action row, the event names already in them (so the site never shows one twice), and the refused. */
export const ledgerFile = (db: DB) => JSON.stringify({ rows: ledgerRows(db), applied: appliedKeys(db), refused: refusedActions(db) });
export interface LedgerFile { rows: ActionRow[]; applied: string[]; refused?: RefusedAction[] }

/** A saved write the next cycle has not applied yet, as the Ledger page and the flip card show it. */
export interface PendingAction {
  key: string; at: number; username: string; action: 'did' | 'sold' | 'other';
  flipKey: string | null; didId: number | null; units: number | null; received: number | null; name: string | null; what: string;
}

const WHAT: Array<[RegExp, string]> = [[/^PUT \/api\/settings$/, 'Settings'], [/^POST \/api\/houses\/pin$/, 'House pins']];

export function pendingActions(events: Array<{ key: string; ev: InboxEvent | null }>, applied: Iterable<string>, nameOf: (flipKey: string | null, didId: number | null) => string | null): PendingAction[] {
  const skip = new Set(applied);
  const out: PendingAction[] = [];
  for (const { key, ev } of events) {
    if (!ev || skip.has(key)) continue;
    const path = ev.url.split('?')[0]!;
    let body: Record<string, unknown> = {};
    try { body = ev.body ? JSON.parse(ev.body) as Record<string, unknown> : {}; } catch { /* not JSON */ }
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
    const did = /^\/api\/flips\/([^/]+)\/did$/.exec(path);
    const sold = /^\/api\/ledger\/(\d+)\/sold$/.exec(path);
    const flipKey = did ? decodeURIComponent(did[1]!) : null;
    const didId = sold ? Number(sold[1]) : null;
    const what = WHAT.find(([re]) => re.test(`${ev.method} ${path}`))?.[1] ?? `${ev.method} ${path}`;
    out.push({ key, at: ev.at, username: ev.user, action: did ? 'did' : sold ? 'sold' : 'other', flipKey, didId,
      units: num(body.units), received: sold ? num(body.received) : null, name: did || sold ? nameOf(flipKey, didId) : null, what: did ? 'I did this' : sold ? 'Sold' : what });
  }
  return out;
}
