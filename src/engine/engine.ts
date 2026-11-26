import type { DB } from '../store/db.ts';
import { getKv, setKv } from '../store/db.ts';
import type { BlizzardClient } from '../blizzard/client.ts';
import { Collector, KINDS, type SnapshotEvent } from './collector.ts';
import { syncHouses, trackedHouses } from './houses.ts';
import { buildContext } from './context.ts';
import { resolveItems, resolveIcons, itemTradeable } from '../catalog/items.ts';
import { vendorDump } from '../detectors/vendorDump.ts';
import { vendorSupply } from '../detectors/vendorSupply.ts';
import { crossHouse } from '../detectors/crossHouse.ts';
import { underpriced } from '../detectors/underpriced.ts';
import { sellNow, heldItems } from '../detectors/sellNow.ts';
import { applyLifecycle } from '../detectors/lifecycle.ts';
import { typicalFloors } from '../analysis/history.ts';
import { UNDERPRICED, MIN_PROFIT_EACH } from '../rules/thresholds.ts';
import { alertCycle, sendDiscord } from '../alerts/discord.ts';
import { computeHealth, writeRunReport } from '../health/report.ts';
import { pool } from '../catalog/items.ts';
import type { DetectorId, Play } from '../detectors/types.ts';
import { hourlyFlips } from '../flips/hourly.ts';
import { chipHouses } from '../flips/houses.ts';
import type { FlipRunResult } from '../flips/run.ts';
import { flipAlertCycle, flushHeldFlipAlerts, type FlipAlertResult } from '../flips/alerts.ts';

/** The engine was busy with a poll round for longer than the caller would wait (the refresh route answers 409). */
export class EngineBusyError extends Error {}

export interface RefreshResult {
  /**
   * 'new': at least one of Chip's houses had a new publish, ingested and counted; 'unchanged': every house that
   * answered gave a 304; 'failed': no house answered, so the flips were not rerun (refresh round 1 finding D).
   */
  status: 'new' | 'unchanged' | 'failed';
  publishes: Array<{ house: number; kind: string; rows: number; at: number }>;
  errors: string[];
  flips: FlipRunResult | null;
  alerts: FlipAlertResult | null;
}

export interface EngineOptions {
  dataDir: string;
  webhookUrl: string | null;
  devWebhookUrl?: string | null;
  appUrl?: string | null;
  log?: (msg: string) => void;
  fetchFn?: typeof fetch;
}

/** The whole pipeline for one poll round: poll every tracked house, then detect, persist and alert if anything published. */
export class Engine {
  readonly collector: Collector;
  private log: (m: string) => void;
  private running = false;
  /** True while a poll round, a refresh or a detect holds the engine. */
  get busy(): boolean { return this.running; }

  /**
   * The one engine lock. Rounds, refreshes and every detect path (startup, house pin) run under it, so no two of them
   * ever overlap and an alert can never be sent twice (refresh round 1 finding A). Waits up to waitMs, then throws
   * EngineBusyError. The check and the set run with no await between them, so two waiters can never both get in.
   */
  private async hold<T>(waitMs: number, fn: () => Promise<T>): Promise<T> {
    const until = Date.now() + waitMs;
    while (this.running) {
      if (Date.now() >= until) throw new EngineBusyError('the engine is in the middle of a poll round; try again in a minute');
      await new Promise(r => setTimeout(r, 200));
    }
    this.running = true;
    try { return await fn(); } finally { this.running = false; }
  }
  lastFlips: FlipRunResult | null = null;
  lastFlipAlerts: FlipAlertResult | null = null;
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
        ({ plays, alerted } = await this.detectHeld());
      }
      // Flip alerts held in quiet hours go out once the quiet period ends, if their flips are still live.
      if (!events.length) {
        try { const f = await flushHeldFlipAlerts(this.db, this.opts.webhookUrl, { fetchFn: this.opts.fetchFn, appUrl: this.opts.appUrl ?? null }); if (f) this.log(`flip alerts after quiet hours: ${f.sent ? `sent ${f.sent}` : f.skipped}`); }
        catch (e) { this.log(`flip alert flush failed: ${(e as Error).message}`); }
      }
      const health = computeHealth(this.db, Date.now(), suspects);
      await this.reportHealthChange(health);
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

  /**
   * Dev channel, never the plays channel. Suspected bugs post once each (they belong to one publish).
   * House outages post as a state change: once when a house is over two hours late or failing, once when all recover.
   */
  private async reportHealthChange(h: ReturnType<typeof computeHealth>): Promise<void> {
    const hook = this.opts.devWebhookUrl;
    const post = async (text: string) => { if (hook) await sendDiscord(hook, text, this.opts.fetchFn); };
    for (const sus of h.suspects) {
      const k = `health:suspect:${sus}`;
      if (getKv(this.db, k)) continue;
      setKv(this.db, k, String(Date.now()));
      await post(`**Suspected bug**\n${sus}. Treated as a bug until proven to be a market fact.`);
    }
    const down = h.houses.filter(x => x.lastError || (x.ageMin ?? 0) > 120).map(x => `${x.name.replace(' Auction House', '')} ${x.id}${x.lastError ? ` failing: ${x.lastError.slice(0, 120)}` : ` ${x.ageMin} min since last publish`}`);
    const state = down.length ? down.map(d => d.split(' ').slice(0, 2).join(' ')).join(', ') : 'ok';
    const prev = getKv(this.db, 'health:houses') ?? 'ok';
    if (state === prev) return;
    setKv(this.db, 'health:houses', state);
    await post(state === 'ok' ? '**Health recovered.** Every house is publishing again.' : `**Health problem**\n${down.join('\n')}`);
  }

  /**
   * Detection over the latest data of every house, then the flips and their alerts. Takes the engine lock, waiting as
   * long as a round or refresh needs: the startup detect and the house pin call this.
   */
  async detect(waitMs = Infinity): Promise<{ plays: Play[]; alerted: number }> {
    return this.hold(waitMs, () => this.detectHeld());
  }

  /** The detect step itself. Cheap apart from the flips. The caller holds the engine lock. */
  private async detectHeld(): Promise<{ plays: Play[]; alerted: number }> {
    const now = Date.now();
    const ctx = buildContext(this.db, this.collector, now);
    const typical = new Map(ctx.houses.map(h => [h.id, typicalFloors(this.db, h.id, { now, minReadings: UNDERPRICED.minReadings, hours: UNDERPRICED.windowHours })]));
    const setting = Number((this.db.prepare(`SELECT value FROM settings WHERE key = 'min_profit_each'`).get() as { value: string } | undefined)?.value);
    const minEach = Number.isFinite(setting) && setting >= 0 ? setting : MIN_PROFIT_EACH;
    // Anything under the minimum profit per item is not worth Chip's time: never stored, shown or alerted.
    ctx.rejects = [];
    const all = [...vendorDump(ctx), ...vendorSupply(ctx), ...crossHouse(ctx), ...underpriced(ctx, typical), ...sellNow(ctx, typical, heldItems(this.db))];
    // Within reach: cap units at what Chip's gold can buy, and hold back anything he cannot afford even once.
    const goldSetting = Number((this.db.prepare(`SELECT value FROM settings WHERE key = 'gold_on_hand'`).get() as { value: string } | undefined)?.value);
    const gold = Number.isFinite(goldSetting) && goldSetting > 0 ? Math.round(goldSetting * 10000) : null;
    for (const p of all) {
      const each = p.detail.buy.kind === 'held' ? 0 : p.detail.buy.price;
      if (gold != null && each > 0) {
        const affordable = Math.floor(gold / each);
        if (affordable < p.detail.realisticUnits) { p.detail.realisticUnits = affordable; p.detail.cappedByGold = true; p.profit = p.detail.perItem * affordable; }
      }
      p.detail.costToDo = each * p.detail.realisticUnits;
    }
    for (const p of all) if (p.detail.realisticUnits <= 0) ctx.rejects.push({ detector: p.detector, houseId: p.houseId, itemId: p.itemId, perItem: p.detail.perItem, reason: `costs ${Math.round(p.detail.buy.price / 100) / 100}g each, more than your gold on hand` });
    const plays = all.filter(p => p.detail.perItem >= minEach && p.detail.realisticUnits > 0);
    for (const p of all) if (p.detail.perItem < minEach) ctx.rejects.push({ detector: p.detector, houseId: p.houseId, itemId: p.itemId, perItem: p.detail.perItem, reason: `under your ${minEach >= 100 ? `${minEach / 100}s` : `${minEach}c`} minimum profit per item` });
    // Closest calls: the best candidates held back this round and why, so an empty board explains itself.
    const seen = new Set<string>();
    const closest = ctx.rejects.filter(r => r.perItem != null && r.perItem > 0).sort((a, b) => b.perItem! - a.perItem!)
      .filter(r => { const k = `${r.detector}:${r.itemId}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
    setKv(this.db, 'closest_calls', JSON.stringify({ at: now, minEach, calls: closest }));
    const detectors: DetectorId[] = ['vendor_dump', 'vendor_supply', 'cross_house', 'underpriced', 'sell_now'];
    const life = applyLifecycle(this.db, plays, { detectors, houses: ctx.houses.map(h => h.id) }, now);
    // Plays left on houses that are no longer evaluated (Chip picked his houses) are closed out.
    if (ctx.houses.length) {
      this.db.prepare(`UPDATE plays SET state = 'gone', gone_at = ? WHERE state != 'gone' AND house_id NOT IN (${ctx.houses.map(() => '?').join(',')})`).run(now, ...ctx.houses.map(h => h.id));
    }
    const pinned = new Set(ctx.houses.filter(h => h.pinned).map(h => h.id));
    const fresh = [...life.created, ...life.updated];
    const a = await alertCycle(this.db, this.opts.webhookUrl, fresh, pinned, { now, fetchFn: this.opts.fetchFn, appUrl: this.opts.appUrl ?? null });
    this.log(`detect: ${plays.length} plays (${life.created.length} new, ${life.gone.length} gone), alert ${a.sent ? `sent ${a.sent}` : a.skipped}`);
    await this.flipsAndAlerts(now);
    return { plays, alerted: a.sent };
  }

  /**
   * The flip engine (docs/flip-plan.md): every flip on Chip's two houses, crafting and flipping ranked together,
   * stored for the page and trends, then the best of the best sent to Discord (src/flips/alerts.ts). The caller holds the engine lock.
   */
  private async flipsAndAlerts(now = Date.now()): Promise<{ flips: FlipRunResult | null; alerts: FlipAlertResult | null }> {
    // Who can trade what, from this hour's listings first, so the flip gate and the page agree.
    try { itemTradeable(this.db, now); } catch (e) { this.log(`tradeable check failed: ${(e as Error).message}`); }
    const flips = hourlyFlips(this.db, (h, k) => this.collector.listings(h, k), now, this.log);
    this.lastFlips = flips; this.lastFlipAlerts = null;
    if (!flips) return { flips, alerts: null };
    try {
      const alerts = await flipAlertCycle(this.db, this.opts.webhookUrl, flips.flips, flips.report,
        { now, fetchFn: this.opts.fetchFn, appUrl: this.opts.appUrl ?? null, held: new Set(flips.heldBack.map(h => h.key)) });
      this.lastFlipAlerts = alerts;
      this.log(`flip alerts: ${alerts.sent ? `sent ${alerts.sent} in ${alerts.posts} post${alerts.posts === 1 ? '' : 's'}` : alerts.skipped}`);
      return { flips, alerts };
    } catch (e) {
      this.log(`flip alerts failed: ${(e as Error).message}`);
      return { flips, alerts: null };
    }
  }

  /**
   * The Refresh button: poll Chip's two houses now (a 304 when nothing is new), count sales, run the full flip
   * analysis and return it. A new publish runs the whole detect step, exactly as a round would, so the next round's
   * 304 never skips the old detectors. Waits up to waitMs for a running round, then throws EngineBusyError.
   */
  async refresh(opts: { waitMs?: number } = {}): Promise<RefreshResult> {
    return this.hold(opts.waitMs ?? 30_000, async () => {
      const events: SnapshotEvent[] = [];
      const errors: string[] = [];
      const jobs = chipHouses(this.db).flatMap(h => KINDS.map(k => ({ h, k })));
      const answered = new Set<number>();
      const rows = new Map(trackedHouses(this.db).map(h => [h.id, h]));
      await pool(jobs, 4, async ({ h, k }) => {
        const row = rows.get(h.id);
        if (!row) { errors.push(`${h.id} ${k}: not a tracked house`); return; }
        try {
          const ev = await this.collector.poll(row, k);
          answered.add(h.id);
          if (ev) { events.push(ev); this.log(`refresh: publish ${h.id} ${k}: ${ev.rows} rows, data from ${new Date(ev.publishedAt).toISOString()}`); }
        } catch (e) { errors.push(`${h.id} ${k}: ${(e as Error).message}`); }
      });
      if (errors.length) this.log(`refresh poll errors: ${errors.join(' | ')}`);
      const now = Date.now();
      const publishes = events.map(e => ({ house: e.house.id, kind: e.kind, rows: e.rows, at: e.publishedAt }));
      // A failed poll is not a 304: with no house answering there is nothing to rerun on, so say so and stop.
      if (!answered.size) return { status: 'failed' as const, publishes, errors, flips: null, alerts: null };
      let out: { flips: FlipRunResult | null; alerts: FlipAlertResult | null };
      if (events.length) {
        const newIds = new Set(events.flatMap(e => e.stats.filter(s => s.listings > 0).map(s => s.itemId)));
        try { await resolveItems(this.client, this.db, [...newIds], { maxAgeMs: Infinity }); await resolveIcons(this.client, this.db, 500); }
        catch (e) { this.log(`refresh catalog failed: ${(e as Error).message}`); }
        // detect() runs the flips; read back what it stored.
        await this.detectHeld();
        out = { flips: this.lastFlips, alerts: this.lastFlipAlerts };
      } else {
        out = await this.flipsAndAlerts(now);
      }
      return { status: events.length ? 'new' as const : 'unchanged' as const, publishes, errors, ...out };
    });
  }

  /** Once a day: refresh vendor sell prices, which hotfixes change (spec 17.3). Returns the changes as news. */
  async refreshCatalog(): Promise<Array<{ id: number; from: number | null; to: number | null }>> {
    const ids = (this.db.prepare('SELECT id FROM items WHERE status = 200').all() as Array<{ id: number }>).map(r => r.id);
    // Thousands of item calls: say so, so a quiet log during this step is never mistaken for a stall.
    const t0 = Date.now();
    this.log(`vendor prices: checking ${ids.length} items older than 20 hours`);
    const r = await resolveItems(this.client, this.db, ids, { maxAgeMs: 20 * 3600_000 });
    this.log(`vendor prices: ${r.fetched} fetched, ${r.errors} errors in ${Math.round((Date.now() - t0) / 1000)} s`);
    if (r.priceChanges.length) setKv(this.db, 'news:vendor_price_changes', JSON.stringify({ at: Date.now(), changes: r.priceChanges.slice(0, 200) }));
    return r.priceChanges;
  }

  dailyDue(now = Date.now()): boolean {
    const last = Number(getKv(this.db, 'daily:last') ?? 0);
    return now - last > 20 * 3600_000;
  }
  markDaily(now = Date.now()): void { setKv(this.db, 'daily:last', String(now)); }
}
