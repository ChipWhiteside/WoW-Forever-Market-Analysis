import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../store/db.ts';
import type { Engine } from '../engine/engine.ts';
import type { BlizzardClient } from '../blizzard/client.ts';
import { PROJECT_ROOT } from '../config/env.ts';
import { listPlays, houseFinder, itemDetail, searchItems, overview } from './queries.ts';
import { computeHealth } from '../health/report.ts';
import { registerExtraRoutes } from './routes-extra.ts';
import { registerFlipRoutes } from './flips.ts';

export interface ServerDeps { db: DB; engine: Engine | null; client: BlizzardClient | null; port: number; dataDir: string; log?: (m: string) => void }

export function buildServer(deps: ServerDeps) {
  const { db } = deps;
  const app = Fastify({ logger: false });

  app.get('/api/overview', async () => ({ ...overview(db), health: computeHealth(db) }));
  app.get('/api/health', async () => computeHealth(db));
  app.get<{ Querystring: { detector?: string; house?: string; gone?: string } }>('/api/plays', async req => listPlays(db, {
    detector: req.query.detector ? req.query.detector.split(',') : undefined,
    house: req.query.house ? Number(req.query.house) : undefined,
    includeGone: req.query.gone === '1',
  }));

  app.post<{ Params: { key: string }; Body: { status: 'done' | 'skipped' | 'already_gone'; quantity?: number; unitCost?: number } }>('/api/plays/:key/status', async (req, reply) => {
    const p = db.prepare('SELECT * FROM plays WHERE key = ?').get(req.params.key) as { item_id: number; house_id: number; detail: string } | undefined;
    if (!p) return reply.code(404).send({ error: 'no such play' });
    db.prepare('UPDATE plays SET user_status = ? WHERE key = ?').run(req.body.status, req.params.key);
    if (req.body.status === 'done' && req.body.quantity && req.body.unitCost != null) {
      db.prepare('INSERT INTO positions (play_key, item_id, house_id, quantity, unit_cost, opened_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.params.key, p.item_id, p.house_id, req.body.quantity, req.body.unitCost, Date.now());
    }
    return { ok: true };
  });

  app.get('/api/houses', async () => houseFinder(db));
  app.post<{ Body: { alliance?: number | null; blackwater?: number | null } }>('/api/houses/pin', async req => {
    for (const [faction, id] of [['alliance', req.body.alliance], ['blackwater', req.body.blackwater]] as const) {
      if (id === undefined) continue;
      db.prepare('UPDATE houses SET pinned = 0 WHERE faction = ?').run(faction);
      if (id) db.prepare('UPDATE houses SET pinned = 1 WHERE id = ? AND faction = ?').run(id, faction);
    }
    // Re-run detection so cross house and alerts reflect the new houses right away.
    if (deps.engine) await deps.engine.detect().catch(() => {});
    return houseFinder(db);
  });

  app.get<{ Querystring: { q: string } }>('/api/items/search', async req => searchItems(db, (req.query.q ?? '').trim()));
  app.get<{ Params: { id: string } }>('/api/items/:id', async req => itemDetail(db, Number(req.params.id)));

  app.get('/api/settings', async () => Object.fromEntries((db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>).map(r => [r.key, r.value])));
  app.put<{ Body: Record<string, string | number> }>('/api/settings', async req => {
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(req.body)) if (/^[a-z_]{2,40}$/.test(k)) up.run(k, String(v));
    return { ok: true };
  });

  app.get('/api/changelog', async () => {
    const f = join(PROJECT_ROOT, 'docs', 'CHANGELOG.md');
    return { markdown: existsSync(f) ? readFileSync(f, 'utf8') : '' };
  });

  registerExtraRoutes(app, deps);
  registerFlipRoutes(app, db);

  const dist = join(PROJECT_ROOT, 'web', 'dist');
  if (existsSync(dist)) {
    app.register(fastifyStatic, { root: dist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'));
  }
  return app;
}

export async function startServer(deps: ServerDeps) {
  const app = buildServer(deps);
  await app.listen({ port: deps.port, host: '127.0.0.1' });
  deps.log?.(`app on http://localhost:${deps.port}`);
  return app;
}
