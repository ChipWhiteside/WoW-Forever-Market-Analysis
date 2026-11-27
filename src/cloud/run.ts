import { mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import Fastify from 'fastify';
import { openDb, type DB } from '../store/db.ts';
import { sleep, type BlizzardClient } from '../blizzard/client.ts';
import { Engine, type RefreshResult } from '../engine/engine.ts';
import { RULESET } from '../engine/houses.ts';
import { KINDS } from '../engine/collector.ts';
import { rawPath, pruneRaw } from '../engine/rawstore.ts';
import { chipHouses } from '../flips/houses.ts';
import { NEW_POSTS } from '../rules/flips.ts';
import { registerFlipRoutes } from '../server/flips.ts';
import { runDailySteps, startupFills, startupFillsNeeded, type Retention } from '../engine/dailySteps.ts';
import type { BlobStore } from './store.ts';
import { RESULTS_KEY, LEDGER_KEY, DB_PREFIX, DB_KEEP_CACHE, DB_KEEP_REMOTE, newestDb, pullDb, pushDb, putJson } from './layout.ts';
import { readEvents, applyEvents, ledgerFile } from './inbox.ts';

const H = 3600_000;
/**
 * Raw snapshots kept in the Actions cache folder: the flips read new posts over 72 hours (NEW_POSTS.windowHours) plus
 * one publish before the window. Pruning works by day folder, so a day goes once its newest file is older than that.
 */
export const RAW_KEEP_HOURS = NEW_POSTS.windowHours + 2;
const RAW_KEEP_DAYS = (RAW_KEEP_HOURS + 24) / 24;
/**
 * Cloud retention (brief item 7), from a measurement on a copy of Chip's data (docs/verification.md G8): Chip's two
 * houses add 1.44 MB of hourly item_stats an hour, so the 30 days the brief asked for is about 1.06 GB (378 MB
 * gzipped), too big for the site's function. Hourly rows are kept 3 days (72 to 96 hours, the whole UTC day kept),
 * which every flip window needs (72 hours) and no more. Daily rollups are kept 30 days in the cloud (about 23 MB),
 * as Chip's coordinator decided (docs/phase2-plan.md item 9); local mode keeps them forever. Raw as above; no local
 * backups (the release keeps the last two databases).
 */
export const CLOUD_RETENTION: Retention = { statsKeepDays: 3, dailyKeepDays: 30, rawKeepDays: RAW_KEEP_DAYS, rawKeepDaysPinned: RAW_KEEP_DAYS, backups: false };

export interface CloudRunOptions {
  /** The cloud store, sealed: release assets and the inbox (src/cloud/layout.ts storeFromEnv). */
  remote: BlobStore;
  /** The sealed database copy in the Actions cache folder (layout.ts cacheStore). */
  cache: BlobStore;
  /** The engine's data folder in the Actions cache: raw snapshots and datasets stay here between runs. */
  dataDir: string;
  client: BlizzardClient;
  webhookUrl?: string | null;
  devWebhookUrl?: string | null;
  appUrl?: string | null;
  /** How long to wait for Blizzard's next publish before running on the stored data. Default 15; 0 for Refresh. */
  waitForPublishMin?: number;
  /** Gap between publish probes. Default 60 s. */
  probeEveryMs?: number;
  log?: (m: string) => void;
  /** Discord's fetch, for tests. */
  fetchFn?: typeof fetch;
  /** The daily dataset refresh; tests swap it. Default runDailySteps. Returns true when every step worked. */
  daily?: (engine: Engine, db: DB, client: BlizzardClient, dataDir: string, log: (m: string) => void, retention: Retention) => Promise<boolean>;
  /** The start up fills for datasets an update added (trainers, game tables); tests swap it. Default startupFills. */
  fills?: (engine: Engine, db: DB, client: BlizzardClient, dataDir: string, log: (m: string) => void) => Promise<void>;
}

export interface CloudRunResult {
  restoredFrom: 'cache' | 'release' | 'fresh';
  refresh: RefreshResult['status'] | null;
  publishes: RefreshResult['publishes'];
  events: { applied: number; refused: number; skipped: number };
  waitedMs: number;
  ms: number;
  bytesDown: number;
  bytesUp: number;
  daily: 'not due' | 'ok' | 'failed';
  dbBytes: number;
  dbGzBytes: number;
  rawFiles: number;
  message: string;
}

/** Counts the bytes that cross the cloud store, so each cycle can say what it cost. */
class Counted implements BlobStore {
  down = 0; up = 0;
  constructor(private s: BlobStore) {}
  async get(key: string) { const r = await this.s.get(key); if (r) this.down += r.body.length; return r; }
  async put(key: string, body: Uint8Array, contentType?: string) { await this.s.put(key, body, contentType); this.up += body.length; }
  delete(key: string) { return this.s.delete(key); }
  list(prefix: string) { return this.s.list(prefix); }
}

/** Chip's houses and the Last-Modified of their newest stored publish per kind. */
function lastPublishes(db: DB): Array<{ house: number; kind: string; lastModified: string | null }> {
  const out: Array<{ house: number; kind: string; lastModified: string | null }> = [];
  for (const h of chipHouses(db)) for (const kind of KINDS) {
    const r = db.prepare('SELECT last_modified FROM snapshots WHERE house_id = ? AND kind = ? ORDER BY published_at DESC LIMIT 1').get(h.id, kind) as { last_modified: string } | undefined;
    out.push({ house: h.id, kind, lastModified: r?.last_modified ?? null });
  }
  return out;
}

/** Wait for Blizzard's next publish with If-Modified-Since. True as soon as any of Chip's houses has a newer one. */
async function waitForPublish(client: BlizzardClient, last: Array<{ house: number; kind: string; lastModified: string | null }>, waitMs: number, everyMs: number, log: (m: string) => void): Promise<boolean> {
  const until = Date.now() + waitMs;
  if (last.some(l => !l.lastModified)) return true;
  for (;;) {
    for (const l of last) {
      const path = `/data/wow/ruleset/${RULESET}/auctions/${l.house}` + (l.kind === 'commodities' ? '/commodities' : '');
      try {
        const r = await client.get(client.url(path, 'dynamic'), z.unknown(), { ifModifiedSince: l.lastModified, retries: 1 });
        if (r.status === 200 && r.lastModified && r.lastModified !== l.lastModified) { log(`publish ready: ${l.kind} ${r.lastModified}`); return true; }
      } catch (e) { log(`publish probe ${l.kind} failed: ${(e as Error).message}`); }
    }
    if (Date.now() + everyMs > until) return false;
    await sleep(everyMs);
  }
}

/** What GET /api/flips answers, from the same route, so the site's static copy can never drift from it. */
export async function flipsPayload(db: DB): Promise<string> {
  const app = Fastify();
  registerFlipRoutes(app, db);
  try {
    const r = await app.inject({ method: 'GET', url: '/api/flips' });
    if (r.statusCode !== 200) throw new Error(`/api/flips answered ${r.statusCode}: ${r.body.slice(0, 200)}`);
    return r.body;
  } finally { await app.close(); }
}

const removeDb = (dir: string) => { for (const s of ['', '-wal', '-shm']) rmSync(join(dir, `wowf.db${s}`), { force: true }); };

/**
 * One hourly cloud cycle (docs/phase2-plan.md), through the existing Engine:
 * 1. Restore the database: the sealed copy in the Actions cache, else the newest release asset (or the release when
 *    it is newer than the cache), else a fresh one.
 * 2. Wait for Blizzard's publish (not for Refresh), apply the site's inbox events, poll, collect, count sales, run
 *    the flips and their alerts: Engine.refresh.
 * 3. Publish: the database (new asset first, then the old deleted, newest 2 kept), results.json and ledger.json,
 *    and the sealed copy in the cache. Then delete the applied events.
 * 4. The daily refresh when due, with cloud retention, then publish again.
 * The plain database never stays in the cache folder: it is removed whatever happens.
 * Safe to rerun: a second run with nothing new polls a 304, reruns the flips on the stored data and publishes again.
 */
export async function cloudRun(opts: CloudRunOptions): Promise<CloudRunResult> {
  const started = Date.now();
  let db: DB | null = null;
  const log = publicLog(opts.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${m}`)), () => db);
  const remote = new Counted(opts.remote);
  const dir = opts.dataDir;
  for (const sub of ['raw', 'datasets', 'reports']) mkdirSync(join(dir, sub), { recursive: true });
  const result: CloudRunResult = { restoredFrom: 'fresh', refresh: null, publishes: [], events: { applied: 0, refused: 0, skipped: 0 }, waitedMs: 0, ms: 0,
    bytesDown: 0, bytesUp: 0, daily: 'not due', dbBytes: 0, dbGzBytes: 0, rawFiles: 0, message: '' };

  try {
    // 1. Restore.
    removeDb(dir);
    const inCache = newestDb(await opts.cache.list(DB_PREFIX));
    const inRelease = newestDb(await remote.list(DB_PREFIX));
    if (inCache && (!inRelease || inCache.at >= inRelease.at) && await pullDb(opts.cache, inCache.key, dir)) result.restoredFrom = 'cache';
    else if (inRelease && await pullDb(remote, inRelease.key, dir)) result.restoredFrom = 'release';
    log(`database restored from ${result.restoredFrom}`);
    db = openDb(dir);

    // Stored raw paths point at the folder of the run that wrote them; point them at this folder's copies.
    const fix = db.prepare('UPDATE snapshots SET raw_path = ? WHERE id = ?');
    for (const s of db.prepare('SELECT id, house_id, kind, published_at FROM snapshots WHERE published_at >= ?').all(Date.now() - RAW_KEEP_HOURS * H - 24 * H) as Array<{ id: number; house_id: number; kind: string; published_at: number }>) {
      const file = rawPath(dir, s.house_id, s.kind, s.published_at);
      if (existsSync(file)) fix.run(file, s.id);
    }

    // 2. Wait, apply the inbox, refresh.
    const t0 = Date.now();
    if (result.restoredFrom !== 'fresh' && (opts.waitForPublishMin ?? 15) > 0) {
      const fresh = await waitForPublish(opts.client, lastPublishes(db), (opts.waitForPublishMin ?? 15) * 60_000, opts.probeEveryMs ?? 60_000, log);
      if (!fresh) log(`no new publish within ${opts.waitForPublishMin ?? 15} min, running on the stored data`);
    }
    result.waitedMs = Date.now() - t0;
    const engine = new Engine(opts.client, db, { dataDir: dir, webhookUrl: opts.webhookUrl ?? null, devWebhookUrl: opts.devWebhookUrl ?? null,
      appUrl: opts.appUrl ?? null, log, fetchFn: opts.fetchFn });
    await engine.init(); // the house index first, so a house pin from the inbox finds its house on a fresh database
    const events = await readEvents(remote);
    const applied = await applyEvents(db, events, log);
    result.events = { applied: applied.applied.filter(a => a.status > 0 && a.status < 400).length, refused: applied.applied.filter(a => a.status === 0 || a.status >= 400).length, skipped: applied.skipped };
    const r = await engine.refresh({ waitMs: 0 });
    result.refresh = r.status;
    result.publishes = r.publishes;
    if (r.errors.length) log(`poll errors: ${r.errors.join(' | ')}`);

    // 3. Publish, then drop the applied events (ledger.json lists them, so the site never shows one twice meanwhile).
    let lastKey: string | null = null;
    const publish = async () => {
      const payload = await flipsPayload(db!);
      db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const pushed = await pushDb([{ store: remote, keep: DB_KEEP_REMOTE }, { store: opts.cache, keep: DB_KEEP_CACHE }], dir, { replaces: lastKey });
      lastKey = pushed.key;
      result.dbGzBytes = pushed.bytes;
      await putJson(remote, RESULTS_KEY, payload);
      await putJson(remote, LEDGER_KEY, ledgerFile(db!));
    };
    await publish();
    for (const e of events) await remote.delete(e.key);

    // 4. The static datasets, daily, after this hour's results are out. Their files stay in the cache folder.
    const need = startupFillsNeeded(engine, db);
    if (engine.dailyDue() || need.trainers || need.gamedata) {
      await (opts.fills ?? startupFills)(engine, db, opts.client, dir, log);
      if (engine.dailyDue()) {
        const ok = await (opts.daily ?? runDailySteps)(engine, db, opts.client, dir, log, CLOUD_RETENTION);
        result.daily = ok ? 'ok' : 'failed';
        if (ok) engine.markDaily();
      }
      await publish();
    }
    // Raw beyond the window goes every cycle, not only with the daily maintenance, so the cache stays small.
    pruneRaw(dir, RAW_KEEP_DAYS, RAW_KEEP_DAYS, new Set());
    result.rawFiles = countRaw(dir);
    result.dbBytes = (db.prepare('SELECT page_count * page_size n FROM pragma_page_count(), pragma_page_size()').get() as { n: number }).n;
    result.message = `cycle ${r.status}: ${r.publishes.length} publishes, ${r.flips?.flips.length ?? 0} flips, ${r.alerts?.sent ?? 0} alerted; `
      + `${result.events.applied} inbox events applied, ${result.events.refused} refused; database ${(result.dbBytes / 1e6).toFixed(1)} MB, ${(result.dbGzBytes / 1e6).toFixed(1)} MB sealed`;
    log(result.message);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    removeDb(dir);
    result.ms = Date.now() - started;
    result.bytesDown = remote.down;
    result.bytesUp = remote.up;
  }
  return result;
}

/**
 * The cycle's log, for the Actions logs, which anyone can read on a public repository. The cycle's own lines are
 * counts only; this also turns the id of every tracked or pinned house into "a house" in the engine's lines (a poll
 * error names its URL), so no line says which houses Chip trades on.
 */
function publicLog(log: (m: string) => void, db: () => DB | null): (m: string) => void {
  return (m: string) => {
    let ids: number[] = [];
    try { ids = (db()?.prepare('SELECT id FROM houses WHERE tracked = 1 OR pinned = 1').all() as Array<{ id: number }> | undefined ?? []).map(h => h.id); } catch { /* not open yet */ }
    log(ids.length ? m.replace(new RegExp(`\\b(${ids.join('|')})\\b`, 'g'), 'a house') : m);
  };
}

function countRaw(dir: string): number {
  const root = join(dir, 'raw');
  if (!existsSync(root)) return 0;
  return readdirSync(root).reduce((n, day) => n + readdirSync(join(root, day)).length, 0);
}
