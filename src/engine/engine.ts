import type { DB } from '../store/db.ts';
import { getKv, setKv } from '../store/db.ts';
import type { BlizzardClient } from '../blizzard/client.ts';
import { Collector, KINDS, type SnapshotEvent } from './collector.ts';
import { syncHouses, trackedHouses } from './houses.ts';
import { buildContext } from './context.ts';
import { resolveItems, resolveIcons } from '../catalog/items.ts';
import { vendorDump } from '../detectors/vendorDump.ts';
import { vendorSupply } from '../detectors/vendorSupply.ts';
import { crossHouse } from '../detectors/crossHouse.ts';
import { underpriced } from '../detectors/underpriced.ts';
import { applyLifecycle } from '../detectors/lifecycle.ts';
import { typicalFloors } from '../analysis/history.ts';
import { UNDERPRICED } from '../rules/thresholds.ts';
import { alertCycle } from '../alerts/discord.ts';
import { computeHealth, writeRunReport } from '../health/report.ts';
import { pool } from '../catalog/items.ts';
import type { DetectorId, Play } from '../detectors/types.ts';

export interface EngineOptions {
  dataDir: string;
  webhookUrl: string | null;
  appUrl?: string | null;
  log?: (msg: string) => void;
  fetchFn?: typeof fetch;
}

/** The whole pipeline for one poll round: poll every tracked house, then detect, persist and alert if anything published. */
export class Engine {
  readonly collector: Collector;
  private log: (m: string) => void;
  private running = false;
  lastHealth: ReturnType<typeof computeHealth> | null = null;

  constructor(private client: BlizzardClient, private db: DB, private opts: EngineOptions) {
    this.collector = new Collector(client, db, opts.dataDir);
    this.log = opts.log ?? (m => console.log(`[${new Date().toISOString()}] ${m}`));
  }

  async init(): Promise<void> {
    const n = await syncHouses(this.client, this.db);
    this.log(`houses: ${n} in index, ${trackedHouses(this.db).length} tracked`);
    for (const h of trackedHouses(this.db)) for (const k of KINDS) this.collector.restore(h.id, k);
  }

  async round(): Promise<{ events: SnapshotEvent[]; plays: Play[]; alerted: number }> {
    if (this.running) return { events: [], plays: [], alerted: 0 };
    this.running = true;
    const started = Date.now();
    try {
      const events: SnapshotEvent[] = [];
      const errors: string[] = [];
      const jobs = trackedHouses(this.db).flatMap(h => KINDS.map(k => ({ h, k })));
      await pool(jobs, 4, async ({ h, k }) => {
        try {
          const ev = await this.collector.poll(h, k);
          if (ev) { events.push(ev); this.log(`publish ${h.id} ${k}: ${ev.rows} rows, data from ${new Date(ev.publishedAt).toISOString()}`); }
        } catch (e) {
          errors.push(`${h.id} ${k}: ${(e as Error).message}`);
        }
      });
      if (errors.length) this.log(`poll errors: ${errors.join(' | ')}`);
      const suspects = events.flatMap(e => e.suspect);
      let plays: Play[] = [];
      let alerted = 0;
      if (events.length) {
        const newIds = new Set(events.flatMap(e => e.stats.filter(s => s.listings > 0).map(s => s.itemId)));
        const r = await resolveItems(this.client, this.db, [...newIds], { maxAgeMs: Infinity });
        if (r.fetched || r.notFound) this.log(`catalog: ${r.fetched} items fetched, ${r.notFound} unknown to Blizzard, ${r.errors} errors`);
        await resolveIcons(this.client, this.db, 500);
        ({ plays, alerted } = await this.detect());
      }
      const health = computeHealth(this.db, Date.now(), suspects);
      this.lastHealth = health;
      if (events.length || errors.length || suspects.length) {
        writeRunReport(this.opts.dataDir, { at: Date.now(), ms: Date.now() - started, publishes: events.map(e => ({ house: e.house.id, kind: e.kind, rows: e.rows, at: e.publishedAt })),
          errors, suspects, plays: plays.length, alerted, health: health.status, healthMessage: health.message });
      }
      return { events, plays, alerted };
    } finally {
      this.running = false;
    }
  }

  /** Detection over the latest data of every house. Cheap, a few hundred milliseconds. */
  async detect(): Promise<{ plays: Play[]; alerted: number }> {
    const now = Date.now();
    const ctx = buildContext(this.db, this.collector, now);
    const typical = new Map(ctx.houses.map(h => [h.id, typicalFloors(this.db, h.id, { now, minReadings: UNDERPRICED.minReadings, hours: UNDERPRICED.windowHours })]));
    const plays = [...vendorDump(ctx), ...vendorSupply(ctx), ...crossHouse(ctx), ...underpriced(ctx, typical)];
    const detectors: DetectorId[] = ['vendor_dump', 'vendor_supply', 'cross_house', 'underpriced'];
    const life = applyLifecycle(this.db, plays, { detectors, houses: ctx.houses.map(h => h.id) }, now);
    const pinned = new Set(ctx.houses.filter(h => h.pinned).map(h => h.id));
    const fresh = [...life.created, ...life.updated];
    const a = await alertCycle(this.db, this.opts.webhookUrl, fresh, pinned, { now, fetchFn: this.opts.fetchFn, appUrl: this.opts.appUrl ?? null });
    this.log(`detect: ${plays.length} plays (${life.created.length} new, ${life.gone.length} gone), alert ${a.sent ? `sent ${a.sent}` : a.skipped}`);
    return { plays, alerted: a.sent };
  }

  /** Once a day: refresh vendor sell prices, which hotfixes change (spec 17.3). Returns the changes as news. */
  async refreshCatalog(): Promise<Array<{ id: number; from: number | null; to: number | null }>> {
    const ids = (this.db.prepare('SELECT id FROM items WHERE status = 200').all() as Array<{ id: number }>).map(r => r.id);
    const r = await resolveItems(this.client, this.db, ids, { maxAgeMs: 20 * 3600_000 });
    if (r.priceChanges.length) setKv(this.db, 'news:vendor_price_changes', JSON.stringify({ at: Date.now(), changes: r.priceChanges.slice(0, 200) }));
    return r.priceChanges;
  }

  dailyDue(now = Date.now()): boolean {
    const last = Number(getKv(this.db, 'daily:last') ?? 0);
    return now - last > 20 * 3600_000;
  }
  markDaily(now = Date.now()): void { setKv(this.db, 'daily:last', String(now)); }
}
