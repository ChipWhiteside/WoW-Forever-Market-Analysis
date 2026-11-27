import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { buildServer } from '../server/server.ts';
import { makeAuth, registerAuth, LOCAL_USER, type AuthConfig } from '../server/auth.ts';
import { ledgerView, ledgerRows, eventRef, EVENT_HEADER } from '../server/ledger.ts';
import type { DB } from '../store/db.ts';
import type { BlobStore } from './store.ts';
import { useSiteDb, dryRun, cachedJson, type SiteDb } from './dbCache.ts';
import { RESULTS_KEY, LEDGER_KEY } from './layout.ts';
import { addEvent, readEvents, pendingActions, appliedKeys, refusedActions, eventRequest, type LedgerFile } from './inbox.ts';
import { dispatchOrJoin, runStatus, type GitHub } from './githubApi.ts';

/**
 * The site's one Vercel function (brief item 6). Every /api request goes through the existing Fastify server by inject,
 * so each route works unchanged. The site never writes the database:
 * - Login, logout and me are answered first and touch no data. Every other request needs the cookie before anything
 *   reaches GitHub, so a caller who is not signed in costs no API calls and no downloads.
 * - GET /api/flips is results.json and GET /api/ledger is ledger.json plus the inbox, so the common pages never wait
 *   for the database; every other GET reads the newest database asset, cached in /tmp by asset id.
 * - The saved inbox events are replayed on a rolled back copy before any other request (dbCache dryRun), so a saved
 *   pin or setting shows at once and a write is judged after the writes saved before it: a Sold works right after
 *   "I did this", and two Solds over the units left are refused at once. A refused write answers as the route does;
 *   a success is saved as an inbox event and answers 202.
 * - Refresh starts the collect workflow, or joins the run already queued or running, and answers 202.
 */
export interface HandlerOpts {
  store: BlobStore;
  /** For Refresh; null when the site runs on a folder store. */
  gh: GitHub | null;
  env: { SITE_PASSWORD?: string; SESSION_SECRET?: string; GITHUB_BRANCH?: string };
  dir?: string;
  /** Workflow dispatch timing, for tests. */
  dispatch?: { findTries?: number; findEveryMs?: number };
  /** The clock of the login limit, for tests. */
  now?: () => number;
}

const HOP = new Set(['connection', 'transfer-encoding', 'keep-alive', 'content-length']);
const AUTH_PATHS = new Set(['/api/login', '/api/logout', '/api/me']);

/**
 * The login limit: after 5 wrong passwords from one address within 10 minutes, that address waits 30 s before the
 * next try. In memory and per instance, so a cold start or another instance starts over; enough against guessing.
 */
export const LOGIN_LIMIT = { fails: 5, windowMs: 10 * 60_000, waitMs: 30_000 };
function loginLimit(now: () => number) {
  const fails = new Map<string, number[]>();
  const recent = (ip: string) => (fails.get(ip) ?? []).filter(t => now() - t < LOGIN_LIMIT.windowMs);
  return {
    /** Milliseconds this address must still wait, 0 when it may try. */
    wait(ip: string): number {
      const f = recent(ip);
      return f.length >= LOGIN_LIMIT.fails ? Math.max(0, f[f.length - 1]! + LOGIN_LIMIT.waitMs - now()) : 0;
    },
    fail(ip: string) {
      if (fails.size > 10_000) for (const k of [...fails.keys()]) if (!recent(k).length) fails.delete(k);
      fails.set(ip, [...recent(ip), now()]);
    },
    clear(ip: string) { fails.delete(ip); },
  };
}
const clientIp = (req: IncomingMessage) => String(req.headers['x-real-ip'] ?? '').trim()
  || String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() || req.socket.remoteAddress || 'unknown';

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, headers: Record<string, unknown>, body: Buffer | string) {
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) res.setHeader(k, v as string | string[]);
  res.statusCode = status;
  res.end(body);
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, JSON.stringify(body));
const runView = (r: { id: number; status: string; conclusion: string | null; html_url: string } | null) =>
  r ? { runId: r.id, state: r.status, conclusion: r.conclusion, url: r.html_url } : { runId: null, state: 'starting', conclusion: null, url: null };

export function makeHandler(o: HandlerOpts) {
  const authCfg: AuthConfig = { password: o.env.SITE_PASSWORD, secret: o.env.SESSION_SECRET };
  const auth = makeAuth(authCfg);
  const limit = loginLimit(o.now ?? Date.now);
  // Login, logout and me: the same routes as the local app, on a server with no database.
  const authApp = Fastify({ logger: false });
  registerAuth(authApp, auth);
  const apps = new WeakMap<DB, FastifyInstance>();
  const appFor = (db: DB) => { let a = apps.get(db); if (!a) { a = buildServer({ db, engine: null, client: null, port: 0, dataDir: o.dir ?? '/tmp', auth: authCfg }); apps.set(db, a); } return a; };

  /**
   * Replay the saved events the published database has not applied yet on a rolled back copy, then answer there.
   * `didEvents` maps each row id a pending "I did this" got on that copy to its event name: such an id is a guess.
   */
  const withPending = async (s: SiteDb, inject: InjectOptions) => {
    const applied = new Set(appliedKeys(s.ro));
    const pending = (await readEvents(o.store)).filter(e => e.ev && !applied.has(e.key));
    const didEvents = new Map<number, string>();
    if (!pending.length && (inject.method === 'GET' || inject.method === 'HEAD')) return { r: await appFor(s.ro).inject(inject), didEvents };
    return dryRun(s, async db => {
      const app = appFor(db);
      for (const { key, ev } of pending) {
        const r = await app.inject(eventRequest(key, ev!, auth.sign(ev!.user)));
        const id = /^\/api\/flips\/[^/]+\/did$/.test(ev!.url) && r.statusCode < 400 ? (r.json() as { id?: number }).id : undefined;
        if (typeof id === 'number') didEvents.set(id, key);
      }
      return { r: await app.inject(inject), didEvents };
    });
  };

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const url = req.url ?? '/';
      const [path, qs] = url.split('?') as [string, string | undefined];
      const query = new URLSearchParams(qs ?? '');
      // Vercel sends only /api/* here (.vercel/output/config.json); anything else is not this function's.
      if (!path.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      const readBodyNow = async () => method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
      // The event header is the replay's own (src/server/ledger.ts EVENT_HEADER), never the caller's.
      const { [EVENT_HEADER]: _ev, ...headers } = req.headers;
      const injectOf = (body: Buffer | undefined): InjectOptions => ({ method: method as InjectOptions['method'], url, headers: headers as Record<string, string>, ...(body?.length ? { payload: body } : {}) });

      // 1. Login, logout and me: no data, no GitHub.
      if (AUTH_PATHS.has(path)) {
        const login = method === 'POST' && path === '/api/login';
        const ip = clientIp(req);
        const wait = login ? limit.wait(ip) : 0;
        if (wait) return json(res, 429, { error: `Too many wrong passwords. Wait ${Math.ceil(wait / 1000)} s and try again.` }, { 'retry-after': String(Math.ceil(wait / 1000)) });
        const r = await authApp.inject(injectOf(await readBodyNow()));
        if (login && r.statusCode === 401) limit.fail(ip);
        if (login && r.statusCode === 200) limit.clear(ip);
        return send(res, r.statusCode, r.headers, r.rawPayload);
      }
      // 2. The cookie, before anything reaches GitHub.
      const user = auth.userOf(req.headers.cookie);
      if (auth.required && !user) return json(res, 401, { error: 'Sign in first.', login: true });
      const body = await readBodyNow();
      const inject = injectOf(body);

      // Refresh: start the hourly workflow now, or join the run already going.
      if (method === 'POST' && path === '/api/flips/refresh') {
        if (!o.gh) return json(res, 503, { error: 'Refresh needs GITHUB_TOKEN and GITHUB_REPO on the site.' });
        const r = await dispatchOrJoin(o.gh, { ref: o.env.GITHUB_BRANCH || 'main', ...o.dispatch });
        return json(res, 202, { status: 'running', joined: r.joined, since: r.since, ...runView(r.run),
          message: r.joined ? REFRESH_JOINED : REFRESH_STARTED });
      }
      if (method === 'GET' && path === '/api/flips/refresh/status') {
        if (!o.gh) return json(res, 503, { error: 'Refresh needs GITHUB_TOKEN and GITHUB_REPO on the site.' });
        const run = Number(query.get('run')) || undefined;
        return json(res, 200, runView(await runStatus(o.gh, { run, since: Number(query.get('since')) || undefined })));
      }

      const listing = await o.store.list('');
      if (method === 'GET' && path === '/api/flips' && query.get('gone') !== '1') {
        const results = await cachedJson<Record<string, unknown>>(o.store, listing, RESULTS_KEY);
        // `online`: the Flips page shows the health banner only here, where the hourly job runs on GitHub.
        if (results) return json(res, 200, { ...results, online: true });
      }
      if (method === 'GET' && path === '/api/ledger') {
        let file = await cachedJson<LedgerFile>(o.store, listing, LEDGER_KEY);
        // Before the first cycle publishes ledger.json: the same rows from the database.
        file ??= await useSiteDb(o.store, listing, async s => ({ rows: ledgerRows(s.ro), applied: appliedKeys(s.ro), refused: refusedActions(s.ro) }), { dir: o.dir });
        const results = await cachedJson<{ flips: Array<{ key: string; detail: { name?: string } }> }>(o.store, listing, RESULTS_KEY);
        const flipName = new Map((results?.flips ?? []).map(f => [f.key, f.detail?.name ?? null]));
        const didName = new Map(file.rows.map(r => [r.id, r.name]));
        const flipOf = (ev: string) => file.rows.find(r => r.event === ev)?.flip_key ?? file.refused?.find(r => r.key === ev)?.flipKey ?? null;
        const pending = pendingActions(await readEvents(o.store), file.applied, (k, id) => (k ? flipName.get(k) : didName.get(id!)) ?? null, flipOf);
        return json(res, 200, { ...ledgerView(file.rows, user ?? LOCAL_USER), pending, refused: file.refused ?? [] });
      }

      return await useSiteDb(o.store, listing, async s => {
        const { r, didEvents } = await withPending(s, inject);
        if (method === 'GET' || method === 'HEAD' || r.statusCode >= 400) return send(res, r.statusCode, r.headers, r.rawPayload);
        // A write the route accepted after every saved one: save it for the next cycle. A Sold on an "I did this" not
        // applied yet names that event, not the row id guessed here, which shifts if an earlier saved write is refused.
        const soldOn = /^\/api\/ledger\/(\d+)\/sold$/.exec(path);
        const didEvent = soldOn ? didEvents.get(Number(soldOn[1])) : undefined;
        const saved = didEvent ? `/api/ledger/${eventRef(didEvent)}/sold${qs ? `?${qs}` : ''}` : url;
        const event = await addEvent(o.store, { at: Date.now(), user: user ?? LOCAL_USER, method, url: saved, contentType: String(req.headers['content-type'] ?? '') || null, body: body?.toString('utf8') ?? '' });
        // The route's own answer, kept as it is (the Houses page reads its list back); an object also says it is pending.
        let parsed: unknown = null;
        try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
        const headers = { ...r.headers, 'x-wowf-pending': event };
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return send(res, 202, headers, r.rawPayload);
        return send(res, 202, { ...headers, 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ...parsed, pending: true, event, message: 'Saved, counts at the next update.' }));
      }, { dir: o.dir });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  };
}

export const REFRESH_STARTED = 'Running on GitHub, usually 1 to 2 minutes.';
/** Joined: the hourly run may still be waiting for Blizzard's publish (up to 15 minutes, src/cloud/run.ts). */
export const REFRESH_JOINED = 'An update is already running on GitHub; waiting for it. Usually 1 to 2 minutes, up to about 15 when it is waiting for Blizzard to publish.';
