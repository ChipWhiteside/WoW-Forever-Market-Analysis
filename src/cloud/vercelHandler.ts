import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildServer } from '../server/server.ts';
import { makeAuth, LOCAL_USER, COOKIE, type AuthConfig } from '../server/auth.ts';
import { ledgerView, ledgerRows } from '../server/ledger.ts';
import type { DB } from '../store/db.ts';
import type { BlobInfo, BlobStore } from './store.ts';
import { siteDb, dryRun, cachedJson } from './dbCache.ts';
import { RESULTS_KEY, LEDGER_KEY } from './layout.ts';
import { addEvent, readEvents, pendingActions, appliedKeys, type LedgerFile, type InboxEvent } from './inbox.ts';
import { dispatchOrJoin, runStatus, type GitHub } from './githubApi.ts';

/**
 * The site's one Vercel function (brief item 6). Every /api request goes through the existing Fastify server by inject,
 * so each route works unchanged. The site never writes the database:
 * - GET /api/flips is results.json and GET /api/ledger is ledger.json plus the inbox, so the common pages never wait
 *   for the database; every other GET reads the newest database asset, cached in /tmp by asset id.
 * - A write is tried on the site's copy and rolled back (dbCache dryRun). A refusal answers as the route does; a
 *   success is saved as an inbox event and answers 202. Other GETs replay the saved events on a rolled back copy first,
 *   so a saved pin or setting shows at once.
 * - Refresh starts the collect workflow, or joins the run already queued or running, and answers 202.
 * - Login, logout and me touch no data.
 */
export interface HandlerOpts {
  store: BlobStore;
  /** For Refresh; null when the site runs on a folder store. */
  gh: GitHub | null;
  env: { SITE_PASSWORD?: string; SESSION_SECRET?: string; GITHUB_BRANCH?: string };
  dir?: string;
  /** Workflow dispatch timing, for tests. */
  dispatch?: { findTries?: number; findEveryMs?: number };
}

const HOP = new Set(['connection', 'transfer-encoding', 'keep-alive', 'content-length']);

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
const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(body));
const runView = (r: { id: number; status: string; conclusion: string | null; html_url: string } | null) =>
  r ? { runId: r.id, state: r.status, conclusion: r.conclusion, url: r.html_url } : { runId: null, state: 'starting', conclusion: null, url: null };

export function makeHandler(o: HandlerOpts) {
  const authCfg: AuthConfig = { password: o.env.SITE_PASSWORD, secret: o.env.SESSION_SECRET };
  const auth = makeAuth(authCfg);
  const apps = new WeakMap<DB, FastifyInstance>();
  const appFor = (db: DB) => { let a = apps.get(db); if (!a) { a = buildServer({ db, engine: null, client: null, port: 0, dataDir: o.dir ?? '/tmp', auth: authCfg }); apps.set(db, a); } return a; };

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const url = req.url ?? '/';
      const [path, qs] = url.split('?') as [string, string | undefined];
      const query = new URLSearchParams(qs ?? '');
      const user = auth.userOf(req.headers.cookie);
      const signedOut = auth.required && !user;
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
      const inject: InjectOptions = { method: method as InjectOptions['method'], url, headers: req.headers as Record<string, string>, ...(body?.length ? { payload: body } : {}) };
      const isApi = path.startsWith('/api/') && !['/api/login', '/api/logout', '/api/me'].includes(path);
      if (signedOut && isApi) return json(res, 401, { error: 'Sign in first.', login: true });

      // Refresh: start the hourly workflow now, or join the run already going.
      if (method === 'POST' && path === '/api/flips/refresh') {
        if (!o.gh) return json(res, 503, { error: 'Refresh needs GITHUB_TOKEN and GITHUB_REPO on the site.' });
        const r = await dispatchOrJoin(o.gh, { ref: o.env.GITHUB_BRANCH || 'main', ...o.dispatch });
        return json(res, 202, { status: 'running', joined: r.joined, since: r.since, ...runView(r.run),
          message: r.joined ? 'An update is already running on GitHub; waiting for it. Usually 1 to 2 minutes.' : 'Running on GitHub, usually 1 to 2 minutes.' });
      }
      if (method === 'GET' && path === '/api/flips/refresh/status') {
        if (!o.gh) return json(res, 503, { error: 'Refresh needs GITHUB_TOKEN and GITHUB_REPO on the site.' });
        const run = Number(query.get('run')) || undefined;
        return json(res, 200, runView(await runStatus(o.gh, { run, since: Number(query.get('since')) || undefined })));
      }

      const listing: BlobInfo[] = await o.store.list('');
      if (method === 'GET' && path === '/api/flips' && query.get('gone') !== '1') {
        const results = await cachedJson<unknown>(o.store, listing, RESULTS_KEY);
        if (results) return json(res, 200, results);
      }
      if (method === 'GET' && path === '/api/ledger') {
        let file = await cachedJson<LedgerFile>(o.store, listing, LEDGER_KEY);
        // Before the first cycle publishes ledger.json: the same rows from the database.
        if (!file) { const s = await siteDb(o.store, listing, { dir: o.dir }); file = { rows: ledgerRows(s.ro), applied: appliedKeys(s.ro) }; }
        const results = await cachedJson<{ flips: Array<{ key: string; detail: { name?: string } }> }>(o.store, listing, RESULTS_KEY);
        const flipName = new Map((results?.flips ?? []).map(f => [f.key, f.detail?.name ?? null]));
        const didName = new Map(file.rows.map(r => [r.id, r.name]));
        const pending = pendingActions(await readEvents(o.store), file.applied, (k, id) => (k ? flipName.get(k) : didName.get(id!)) ?? null);
        return json(res, 200, { ...ledgerView(file.rows, user ?? LOCAL_USER), pending });
      }

      const s = await siteDb(o.store, listing, { dir: o.dir });
      if (method === 'GET' || method === 'HEAD' || !isApi) {
        // Saved writes count at the next update, but pages show them now (a saved pin, saved settings): replay the
        // pending events through their routes on a rolled back copy, then answer the GET there.
        const applied = new Set(appliedKeys(s.ro));
        const pending = isApi ? (await readEvents(o.store)).filter(e => e.ev && !applied.has(e.key)) : [];
        const r = !pending.length ? await appFor(s.ro).inject(inject) : await dryRun(s, async db => {
          const app = appFor(db);
          for (const { ev } of pending) await app.inject(replay(ev!, auth.sign(ev!.user)));
          return app.inject(inject);
        });
        return send(res, r.statusCode, r.headers, r.rawPayload);
      }

      // A write: try it on a rolled back copy, then save it for the next cycle.
      const tried = await dryRun(s, db => appFor(db).inject(inject));
      if (tried.statusCode >= 400) return send(res, tried.statusCode, tried.headers, tried.rawPayload);
      const event = await addEvent(o.store, { at: Date.now(), user: user ?? LOCAL_USER, method, url, contentType: String(req.headers['content-type'] ?? '') || null, body: body?.toString('utf8') ?? '' });
      // The route's own answer, kept as it is (the Houses page reads its list back); an object also says it is pending.
      let parsed: unknown = null;
      try { parsed = JSON.parse(tried.body); } catch { /* not JSON */ }
      const headers = { ...tried.headers, 'x-wowf-pending': event };
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return send(res, 202, headers, tried.rawPayload);
      return send(res, 202, { ...headers, 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ...parsed, pending: true, event, message: 'Saved, counts at the next update.' }));
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  };
}

/** An inbox event as an inject request, signed in as the person who saved it. */
const replay = (ev: InboxEvent, token: string): InjectOptions => ({
  method: ev.method as InjectOptions['method'], url: ev.url,
  headers: { cookie: `${COOKIE}=${encodeURIComponent(token)}`, ...(ev.contentType ? { 'content-type': ev.contentType } : {}) },
  ...(ev.body ? { payload: ev.body } : {}),
});
