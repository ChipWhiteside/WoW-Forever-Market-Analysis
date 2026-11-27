import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildServer } from '../server/server.ts';
import { makeAuth } from '../server/auth.ts';
import type { DB } from '../store/db.ts';
import type { BlobStore } from './store.ts';
import { getDb, invalidateDb, withWriteDb, DbLockHeldError } from './dbCache.ts';
import { runCloudCycle, type CloudEnv } from './run.ts';

/**
 * The site's one Vercel function (docs/phase2-plan.md item 4): every /api request goes through the existing Fastify
 * server by inject, so each route works unchanged.
 * - GET and HEAD read the cached, read only database.
 * - Login and logout touch no data, so they also use the read copy and never wait for the lock.
 * - Every other write runs under the store lock on a fresh copy, which is uploaded when the route answers below 400.
 * - Refresh runs the cloud cycle inline. A held lock answers 409.
 */
export interface HandlerOpts { store: BlobStore; env: CloudEnv; dir?: string; runCycle?: typeof runCloudCycle }

const NO_LOCK = new Set(['/api/login', '/api/logout']);
const HOP = new Set(['connection', 'transfer-encoding', 'keep-alive']);

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
const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(body));
const isLockError = (e: unknown) => e instanceof DbLockHeldError || /\block\b/i.test(String((e as Error)?.message ?? ''));

export function makeHandler(o: HandlerOpts) {
  const authCfg = { password: o.env.SITE_PASSWORD, secret: o.env.SESSION_SECRET };
  const auth = makeAuth(authCfg);
  const runCycle = o.runCycle ?? runCloudCycle;
  const apps = new WeakMap<DB, FastifyInstance>();
  const build = (db: DB) => buildServer({ db, engine: null, client: null, port: 0, dataDir: o.dir ?? '/tmp', auth: authCfg });
  const readApp = async () => {
    const { db } = await getDb(o.store, { dir: o.dir });
    let app = apps.get(db);
    if (!app) { app = build(db); apps.set(db, app); }
    return app;
  };

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const url = req.url ?? '/';
      const path = url.split('?')[0]!;
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
      const inject: InjectOptions = { method: method as InjectOptions['method'], url, headers: req.headers as Record<string, string>, ...(body?.length ? { payload: body } : {}) };

      if (method === 'POST' && path === '/api/flips/refresh') {
        if (auth.required && !auth.userOf(req.headers.cookie)) return json(res, 401, { error: 'Sign in first.', login: true });
        let r: Awaited<ReturnType<typeof runCloudCycle>>;
        try { r = await runCycle(o.store, o.env); } catch (e) {
          if (isLockError(e)) return json(res, 409, { error: 'Busy: the hourly run holds the lock. Try again in a minute.' });
          throw e;
        }
        invalidateDb(o.store);
        const { db } = await getDb(o.store, { dir: o.dir });
        const run = db.prepare('SELECT at, data_at, ms, complete, report FROM flip_runs ORDER BY at DESC LIMIT 1').get() as { at: number; data_at: number; ms: number; complete: number; report: string } | undefined;
        return json(res, 200, {
          status: r?.status ?? 'new', message: r?.message ?? 'Cloud run done: sales counted and flips rerun.', errors: r?.errors ?? [], publishes: [],
          run: run ? { ...run, complete: !!run.complete, report: JSON.parse(run.report) } : null,
        });
      }

      if (method === 'GET' || method === 'HEAD' || NO_LOCK.has(path)) {
        const r = await (await readApp()).inject(inject);
        return send(res, r.statusCode, r.headers, r.rawPayload);
      }

      const owner = `vercel:${randomBytes(4).toString('hex')}`;
      const r = await withWriteDb(o.store, owner, async db => {
        const app = build(db);
        try {
          const out = await app.inject(inject);
          return { commit: out.statusCode < 400, value: out };
        } finally { await app.close(); }
      }, { dir: o.dir });
      return send(res, r.statusCode, r.headers, r.rawPayload);
    } catch (e) {
      if (isLockError(e)) return json(res, 409, { error: 'Busy: the hourly run holds the lock. Try again in a minute.' });
      return json(res, 500, { error: (e as Error).message });
    }
  };
}
