import type { FastifyInstance } from 'fastify';
import type { DB } from '../store/db.ts';
import { getKv } from '../store/db.ts';

/** The Flips page: the ranked list, the latest run report, and what was held back and why. */
export function registerFlipRoutes(app: FastifyInstance, db: DB): void {
  app.get<{ Querystring: { gone?: string } }>('/api/flips', async req => {
    const rows = db.prepare(`SELECT f.key, f.kind, f.family, f.house_id, f.item_id, f.recipe_id, f.state, f.rank, f.expected_profit, f.risk, f.detail,
        f.first_seen, f.last_seen, f.data_at, f.gone_at, i.icon_url, i.quality, h.name house_name, h.faction
      FROM flips f LEFT JOIN items i ON i.id = f.item_id LEFT JOIN houses h ON h.id = f.house_id
      WHERE ${req.query.gone === '1' ? '1' : `f.state != 'gone'`}
      ORDER BY CASE WHEN f.state = 'gone' THEN 1 ELSE 0 END, f.rank IS NULL, f.rank, f.expected_profit DESC LIMIT 1000`).all() as Array<Record<string, unknown> & { detail: string }>;
    const run = db.prepare('SELECT at, data_at, ms, complete, report FROM flip_runs ORDER BY at DESC LIMIT 1').get() as { at: number; data_at: number; ms: number; complete: number; report: string } | undefined;
    const held = getKv(db, 'flip_held_back');
    return {
      flips: rows.map(r => ({ ...r, detail: JSON.parse(r.detail) })),
      run: run ? { ...run, complete: !!run.complete, report: JSON.parse(run.report) } : null,
      heldBack: held ? JSON.parse(held) : [],
    };
  });
}
