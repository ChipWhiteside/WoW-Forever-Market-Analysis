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
import { sellNow, heldItems } from '../detectors/sellNow.ts';
import { applyLifecycle } from '../detectors/lifecycle.ts';
import { typicalFloors } from '../analysis/history.ts';
import { UNDERPRICED, MIN_PROFIT_EACH } from '../rules/thresholds.ts';
import { alertCycle, sendDiscord } from '../alerts/discord.ts';
import { computeHealth, writeRunReport } from '../health/report.ts';
import { pool } from '../catalog/items.ts';
import type { DetectorId, Play } from '../detectors/types.ts';

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

  /** Detection over the latest data of every house. Cheap, a few hundred milliseconds. */
  async detect(): Promise<{ plays: Play[]; alerted: number }> {
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
