import type { FastifyInstance } from 'fastify';
import type { DB } from '../store/db.ts';
import { getKv } from '../store/db.ts';
import { EngineBusyError, type Engine } from '../engine/engine.ts';

/** How many gone flips ?gone=1 adds: the most recent. */
export const GONE_LIMIT = 200;

/** The Flips page: the ranked list, the latest run report, and what was held back and why. */
export function registerFlipRoutes(app: FastifyInstance, db: DB, engine: Engine | null = null, refreshWaitMs = 30_000): void {
  app.get<{ Querystring: { gone?: string } }>('/api/flips', async req => {
    const cols = `f.key, f.kind, f.family, f.house_id, f.item_id, f.recipe_id, f.state, f.rank, f.expected_profit, f.risk, f.detail,
        f.first_seen, f.last_seen, f.data_at, f.gone_at, i.icon_url, i.quality, h.name house_name, h.faction
      FROM flips f LEFT JOIN items i ON i.id = f.item_id LEFT JOIN houses h ON h.id = f.house_id`;
    const rows = db.prepare(`SELECT ${cols} WHERE f.state != 'gone' ORDER BY f.rank IS NULL, f.rank, f.expected_profit DESC LIMIT 1000`).all() as Array<Record<string, unknown> & { detail: string }>;
    // ?gone=1 adds the GONE_LIMIT most recently gone, after the live ones, so the answer stays far under Vercel's 4.5 MB.
    if (req.query.gone === '1') rows.push(...db.prepare(`SELECT ${cols} WHERE f.state = 'gone' ORDER BY f.gone_at DESC, f.last_seen DESC LIMIT ?`).all(GONE_LIMIT) as Array<Record<string, unknown> & { detail: string }>);
    const run = db.prepare('SELECT at, data_at, ms, complete, report FROM flip_runs ORDER BY at DESC LIMIT 1').get() as { at: number; data_at: number; ms: number; complete: number; report: string } | undefined;
    const held = getKv(db, 'flip_held_back');
    return {
      flips: rows.map(r => ({ ...r, detail: JSON.parse(r.detail) })),
      run: run ? { ...run, complete: !!run.complete, report: JSON.parse(run.report) } : null,
      heldBack: held ? JSON.parse(held) : [],
    };
  });

  /**
   * The Refresh button (Chip, November 26): poll Chip's houses now, count sales, rerun the flips, answer with the
   * newest run. 503 when this process has no engine; 409 when a poll round keeps the engine busy past the wait.
   */
  app.post('/api/flips/refresh', async (_req, reply) => {
    if (!engine) return reply.code(503).send({ error: 'The engine is not running in this process, so there is nothing to refresh. Start the app with npm run engine.' });
    try {
      const r = await engine.refresh({ waitMs: refreshWaitMs });
      const run = db.prepare('SELECT at, data_at, ms, complete, report FROM flip_runs ORDER BY at DESC LIMIT 1').get() as { at: number; data_at: number; ms: number; complete: number; report: string } | undefined;
      // Poll errors are said plainly, by house, and never read as a 304 (refresh round 1 finding D).
      const byHouse = new Map<string, string[]>();
      for (const e of r.errors) { const [house, , ...rest] = e.split(' '); const m = rest.join(' '); byHouse.set(house!, [...(byHouse.get(house!) ?? []), m]); }
      const failures = [...byHouse].map(([h, ms]) => `Blizzard did not answer for house ${h}: ${[...new Set(ms)].join('; ')}.`).join(' ');
      const message = r.status === 'failed'
        ? `${failures} Flips not rerun; the list is from the last good data.`
        : `${r.status === 'new'
          ? `New data from Blizzard for ${[...new Set(r.publishes.map(p => p.house))].join(' and ')}: sales counted and flips rerun.`
          : 'Nothing new from Blizzard yet (304). Flips rerun on the stored data.'}${failures ? ` ${failures}` : ''}`;
      return {
        status: r.status, message, publishes: r.publishes, errors: r.errors,
        flips: r.flips?.flips.length ?? 0, alerted: r.alerts?.sent ?? 0,
        run: run ? { ...run, complete: !!run.complete, report: JSON.parse(run.report) } : null,
      };
    } catch (e) {
      if (e instanceof EngineBusyError) return reply.code(409).send({ error: `Busy: ${e.message}.` });
      throw e;
    }
  });
}
