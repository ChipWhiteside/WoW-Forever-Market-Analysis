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
 * because two people raced) is logged and counted as applied, so it never blocks the queue.
 */
export async function applyEvents(db: DB, events: Array<{ key: string; ev: InboxEvent | null; error?: string }>, log: (m: string) => void): Promise<ApplyResult> {
  const done = appliedKeys(db);
  const seen = new Set(done);
  const out: ApplyResult = { applied: [], skipped: 0 };
  const fresh = events.filter(e => { if (seen.has(e.key)) { out.skipped++; return false; } return true; });
  if (!fresh.length) return out;
  const auth = { password: null, secret: randomBytes(32).toString('hex') };
  const sign = makeAuth(auth);
  const app = buildServer({ db, engine: null, client: null, port: 0, dataDir: '', auth });
  try {
    for (const { key, ev, error } of fresh) {
      if (!ev) { out.applied.push({ key, status: 0, error }); log(`inbox ${key}: unreadable, dropped`); }
      else {
        const r = await app.inject({ method: ev.method as 'POST', url: ev.url,
          headers: { cookie: `${COOKIE}=${encodeURIComponent(sign.sign(ev.user))}`, ...(ev.contentType ? { 'content-type': ev.contentType } : {}) },
          ...(ev.body ? { payload: ev.body } : {}) });
        const err = r.statusCode >= 400 ? r.body.slice(0, 200) : undefined;
        out.applied.push({ key, status: r.statusCode, ...(err ? { error: err } : {}) });
        // Actions logs are public: the status only, never the body (it can name a person).
        log(`inbox ${key}: ${ev.method} ${ev.url.split('?')[0]} answered ${r.statusCode}`);
      }
      done.push(key);
      setKv(db, APPLIED_KV, JSON.stringify(done.slice(-APPLIED_KEEP)));
    }
  } finally { await app.close(); }
  return out;
}

/** ledger.json: every action row, and the event names already in them, so the site never shows one twice. */
export const ledgerFile = (db: DB) => JSON.stringify({ rows: ledgerRows(db), applied: appliedKeys(db) });
export interface LedgerFile { rows: ActionRow[]; applied: string[] }

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
