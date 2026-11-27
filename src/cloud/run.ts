import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import Fastify from 'fastify';
import { openDb, type DB } from '../store/db.ts';
import { sleep, type BlizzardClient } from '../blizzard/client.ts';
import { Engine, type RefreshResult } from '../engine/engine.ts';
import { RULESET } from '../engine/houses.ts';
import { KINDS } from '../engine/collector.ts';
import { rawPath } from '../engine/rawstore.ts';
import { chipHouses } from '../flips/houses.ts';
import { registerFlipRoutes } from '../server/flips.ts';
import { runDailySteps, startupFills, startupFillsNeeded } from '../engine/dailySteps.ts';
import type { BlobInfo, BlobStore } from './store.ts';
import { DB_KEY, RESULTS_KEY, RAW_PREFIX, DATASETS_PREFIX, ENGINE_LOCK, pullDb, pushDb } from './layout.ts';

const H = 3600_000;
/** Raw snapshots pulled for the cycle: the flips read up to 24 hours of new posts, plus slack. */
export const RAW_PULL_HOURS = 26;

export interface CloudRunOptions {
  store: BlobStore;
  client: BlizzardClient;
  webhookUrl?: string | null;
  devWebhookUrl?: string | null;
  appUrl?: string | null;
  /** How long to wait for Blizzard's next publish before running on the stored data. Default 15. */
  waitForPublishMin?: number;
  /** Gap between publish probes. Default 60 s. */
  probeEveryMs?: number;
  rawKeepDays?: number;
  /** Lock lifetime; a crashed run frees the lock after this. Default 60 min. */
  lockTtlMs?: number;
  owner?: string;
  log?: (m: string) => void;
  /** Discord's fetch, for tests. */
  fetchFn?: typeof fetch;
  /** The daily dataset refresh; tests swap it. Default runDailySteps. Returns true when every step worked. */
  daily?: (engine: Engine, db: DB, client: BlizzardClient, dataDir: string, log: (m: string) => void) => Promise<boolean>;
  /** The start up fills for datasets an update added (trainers, game tables); tests swap it. Default startupFills. */
  fills?: (engine: Engine, db: DB, client: BlizzardClient, dataDir: string, log: (m: string) => void) => Promise<void>;
  /** Keep the work folder (for measuring); default removes it. */
  keepWorkDir?: boolean;
}

export interface CloudRunResult {
  status: 'locked' | 'done';
  message: string;
  refresh: RefreshResult['status'] | null;
  publishes: RefreshResult['publishes'];
  waitedMs: number;
  ms: number;
  bytesDown: number;
  bytesUp: number;
  rawPulled: number;
  rawPushed: number;
  rawPruned: number;
  daily: 'not due' | 'ok' | 'failed';
  dbBytes: number;
  workDir: string;
}

/** Counts the bytes that cross the store, so each cycle can say what it cost. */
class Counted implements BlobStore {
  down = 0; up = 0;
  constructor(private s: BlobStore) {}
  async get(key: string) { const r = await this.s.get(key); if (r) this.down += r.body.length; return r; }
  head(key: string) { return this.s.head(key); }
  async put(key: string, body: Uint8Array, contentType?: string) { await this.s.put(key, body, contentType); this.up += body.length; }
  delete(key: string) { return this.s.delete(key); }
  async deleteMany(keys: string[]) { if (this.s.deleteMany) await this.s.deleteMany(keys); else for (const k of keys) await this.s.delete(k); }
  list(prefix: string) { return this.s.list(prefix); }
  lock(name: string, ttlMs: number, owner: string) { return this.s.lock(name, ttlMs, owner); }
  async lockHolder(name: string) { return this.s.lockHolder ? this.s.lockHolder(name) : null; }
}

/** `raw/2026-11-26/111-auctions-1795703173000.json.gz` to its parts; null for anything else. */
export function parseRawKey(key: string): { day: string; house: number; kind: string; publishedAt: number; file: string } | null {
  const m = /^raw\/(\d{4}-\d{2}-\d{2})\/((\d+)-(auctions|commodities)-(\d+)\.json\.gz)$/.exec(key);
  return m ? { day: m[1]!, file: m[2]!, house: Number(m[3]), kind: m[4]!, publishedAt: Number(m[5]) } : null;
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

/**
 * Wait for Blizzard's next publish with If-Modified-Since, before taking the lock, so the site's writes are never
 * blocked by the wait. Returns as soon as any of Chip's houses has a publish newer than the stored one.
 */
async function waitForPublish(client: BlizzardClient, last: Array<{ house: number; kind: string; lastModified: string | null }>, waitMs: number, everyMs: number, log: (m: string) => void): Promise<boolean> {
  const until = Date.now() + waitMs;
  if (last.some(l => !l.lastModified)) return true;
  for (;;) {
    for (const l of last) {
      const path = `/data/wow/ruleset/${RULESET}/auctions/${l.house}` + (l.kind === 'commodities' ? '/commodities' : '');
      try {
        const r = await client.get(client.url(path, 'dynamic'), z.unknown(), { ifModifiedSince: l.lastModified, retries: 1 });
        if (r.status === 200 && r.lastModified && r.lastModified !== l.lastModified) { log(`publish ready: ${l.house} ${l.kind} ${r.lastModified}`); return true; }
      } catch (e) { log(`publish probe ${l.house} ${l.kind} failed: ${(e as Error).message}`); }
    }
    if (Date.now() + everyMs > until) return false;
    await sleep(everyMs);
  }
}

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p)); else out.push(p);
  }
  return out;
}
const toKey = (root: string, file: string) => relative(root, file).split(sep).join('/');

/** Pull every cached dataset file into dataDir/datasets. Returns the MD5 of each, by key, to see what changed. */
async function pullDatasets(store: BlobStore, dataDir: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  for (const o of await store.list(DATASETS_PREFIX)) {
    if (!o.key.endsWith('.gz')) continue;
    const got = await store.get(o.key);
    if (!got) continue;
    const body = gunzipSync(got.body);
    const rel = o.key.slice(0, -3);
    const file = join(dataDir, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    seen.set(rel, md5(body));
  }
  return seen;
}

/** Push dataset files that are new or changed, and remove from the store any the refresh removed. */
async function pushDatasets(store: BlobStore, dataDir: string, before: Map<string, string>): Promise<number> {
  let pushed = 0;
  const now = new Set<string>();
  for (const file of walkFiles(join(dataDir, 'datasets'))) {
    const rel = toKey(dataDir, file);
    now.add(rel);
    const body = readFileSync(file);
    if (before.get(rel) === md5(body)) continue;
    await store.put(`${rel}.gz`, gzipSync(body, { level: 6 }), 'application/gzip');
    pushed++;
  }
  const gone = [...before.keys()].filter(k => !now.has(k)).map(k => `${k}.gz`);
  if (gone.length) await deleteKeys(store, gone);
  return pushed;
}

async function deleteKeys(store: BlobStore, keys: string[]): Promise<void> {
  if (!keys.length) return;
  if (store.deleteMany) await store.deleteMany(keys); else for (const k of keys) await store.delete(k);
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

/**
 * One hourly cloud cycle (docs/phase2-plan.md, item 2), through the existing Engine. Safe to rerun: a second run with
 * nothing new polls a 304, reruns the flips on the stored data and rewrites the same files. Safe when the lock is
 * held: it says who holds it and returns status 'locked' without touching anything.
 */
export async function cloudRun(opts: CloudRunOptions): Promise<CloudRunResult> {
  const started = Date.now();
  const log = opts.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${m}`));
  const store = new Counted(opts.store);
  const owner = opts.owner ?? `${hostname()}:${process.pid}`;
  const workDir = mkdtempSync(join(tmpdir(), 'wowf-cloud-'));
  for (const sub of ['raw', 'datasets', 'reports', 'backups']) mkdirSync(join(workDir, sub), { recursive: true });
  const result: CloudRunResult = { status: 'done', message: '', refresh: null, publishes: [], waitedMs: 0, ms: 0, bytesDown: 0, bytesUp: 0,
    rawPulled: 0, rawPushed: 0, rawPruned: 0, daily: 'not due', dbBytes: 0, workDir };
  const finish = () => { result.ms = Date.now() - started; result.bytesDown = store.down; result.bytesUp = store.up; if (!opts.keepWorkDir) rmSync(workDir, { recursive: true, force: true }); return result; };

  // 0. Wait for the publish, outside the lock. The database is pulled read only to learn the last Last-Modified.
  const t0 = Date.now();
  let pulled = await pullDb(store, workDir);
  if (pulled) {
    const peek = openDb(workDir);
    const last = lastPublishes(peek);
    peek.close();
    const fresh = await waitForPublish(opts.client, last, (opts.waitForPublishMin ?? 15) * 60_000, opts.probeEveryMs ?? 60_000, log);
    if (!fresh) log(`no new publish within ${opts.waitForPublishMin ?? 15} min, running on the stored data`);
  }
  result.waitedMs = Date.now() - t0;

  // 1. Take the lock.
  const release = await store.lock(ENGINE_LOCK, opts.lockTtlMs ?? 60 * 60_000, owner);
  if (!release) {
    const h = await store.lockHolder(ENGINE_LOCK);
    result.status = 'locked';
    result.message = `The engine lock is held${h ? ` by ${h.owner} until ${new Date(h.expiresAt).toISOString()}` : ''}. Nothing done; the next run tries again.`;
    log(result.message);
    return finish();
  }
  let db: DB | null = null;
  try {
    // 2. The database again if it changed while waiting, then the last 26 hours of raw snapshots for Chip's houses.
    const head = await store.head(DB_KEY);
    if (!pulled || (head && head.etag !== pulled.etag)) pulled = await pullDb(store, workDir);
    db = openDb(workDir);
    const houses = new Set(chipHouses(db).map(h => h.id));
    const rawListing: BlobInfo[] = await store.list(RAW_PREFIX);
    const stored = new Set(rawListing.map(o => o.key));
    const since = Date.now() - RAW_PULL_HOURS * H;
    for (const o of rawListing) {
      const k = parseRawKey(o.key);
      if (!k || !houses.has(k.house) || k.publishedAt < since) continue;
      const got = await store.get(o.key);
      if (!got) continue;
      const file = rawPath(workDir, k.house, k.kind, k.publishedAt);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, got.body);
      result.rawPulled++;
    }
    // Stored raw paths point at the folder of the run that wrote them; point them at this run's copies.
    const fix = db.prepare('UPDATE snapshots SET raw_path = ? WHERE id = ?');
    for (const s of db.prepare('SELECT id, house_id, kind, published_at FROM snapshots WHERE published_at >= ?').all(since) as Array<{ id: number; house_id: number; kind: string; published_at: number }>) {
      const file = rawPath(workDir, s.house_id, s.kind, s.published_at);
      if (existsSync(file)) fix.run(file, s.id);
    }

    // 3. Poll Blizzard for Chip's houses, collect, count sales, run the flips and their alerts: the Engine's refresh.
    const engine = new Engine(opts.client, db, { dataDir: workDir, webhookUrl: opts.webhookUrl ?? null, devWebhookUrl: opts.devWebhookUrl ?? null,
      appUrl: opts.appUrl ?? null, log, fetchFn: opts.fetchFn });
    await engine.init();
    const r = await engine.refresh({ waitMs: 0 });
    result.refresh = r.status;
    result.publishes = r.publishes;
    if (r.errors.length) log(`poll errors: ${r.errors.join(' | ')}`);

    // 4 and 5. Push the new raw snapshots, then the database, then results.json.
    const pushRaw = async () => {
      for (const file of walkFiles(join(workDir, 'raw'))) {
        const key = toKey(workDir, file);
        if (stored.has(key) || !parseRawKey(key)) continue;
        await store.put(key, readFileSync(file), 'application/gzip');
        stored.add(key);
        result.rawPushed++;
      }
    };
    const pushAll = async () => {
      await pushRaw();
      const payload = await flipsPayload(db!);
      db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      result.dbBytes = await pushDb(store, workDir);
      await store.put(RESULTS_KEY, new TextEncoder().encode(payload), 'application/json');
    };
    await pushAll();

    // The static datasets, daily, in the same cycle, after this hour's results are out. Their files are cached in the store.
    const need = startupFillsNeeded(engine, db);
    if (engine.dailyDue() || need.trainers || need.gamedata) {
      const before = await pullDatasets(store, workDir);
      await (opts.fills ?? startupFills)(engine, db, opts.client, workDir, log);
      if (engine.dailyDue()) {
        const ok = await (opts.daily ?? runDailySteps)(engine, db, opts.client, workDir, log);
        result.daily = ok ? 'ok' : 'failed';
        if (ok) engine.markDaily();
      }
      const n = await pushDatasets(store, workDir, before);
      log(`datasets: ${n} files pushed`);
      await pushAll();
    }

    // 6. Prune raw snapshots older than the window.
    const cutoff = Date.now() - (opts.rawKeepDays ?? 14) * 86_400_000;
    const old = [...stored].filter(k => { const p = parseRawKey(k); return p && p.publishedAt < cutoff; });
    await deleteKeys(store, old);
    result.rawPruned = old.length;

    result.message = `cycle ${r.status}: ${r.publishes.length} publishes, ${r.flips?.flips.length ?? 0} flips, ${r.alerts?.sent ?? 0} alerted; raw ${result.rawPulled} pulled, ${result.rawPushed} pushed, ${result.rawPruned} pruned`;
    log(result.message);
  } catch (e) {
    if (!opts.keepWorkDir) rmSync(workDir, { recursive: true, force: true });
    throw e;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    // 7. Release the lock, whatever happened.
    await release();
  }
  return finish();
}
