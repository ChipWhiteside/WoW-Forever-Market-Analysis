/**
 * The Vercel build (scripts/build-vercel.ts) proved without Vercel: build the Build Output API folder, then import the
 * bundled function in a plain `node` process, with no TypeScript loader, and call its handler through a node http
 * server. Its GitHub calls go to the fake GitHub API (tests/fakeGitHub.ts), served over http from this process, and
 * this process seeds and reads the fake with the real sealed store.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildVercel, FUNC } from '../../scripts/build-vercel.ts';
import { openDb } from '../../src/store/db.ts';
import { GitHubStore } from '../../src/cloud/githubStore.ts';
import { GitHub } from '../../src/cloud/githubApi.ts';
import { SealedStore } from '../../src/cloud/crypto.ts';
import { pushDb, putJson, RESULTS_KEY, LEDGER_KEY } from '../../src/cloud/layout.ts';
import { readEvents, ledgerFile } from '../../src/cloud/inbox.ts';
import { tempDir } from '../helpers.ts';
import { fakeGitHub, REPO } from '../fakeGitHub.ts';

const run = promisify(execFile);
const KEY = randomBytes(32);
const f = fakeGitHub();
const gh = new GitHub({ token: f.token, repo: REPO, fetchFn: f.fetchFn, sleep: async () => {} });
const store = new SealedStore(new GitHubStore(gh, { sleep: async () => {} }), KEY);
let fake: Server;
let fakeUrl = '';
let built: Awaited<ReturnType<typeof buildVercel>>;

/** The fake GitHub over http: /<host>/<path> is the call to https://<host>/<path>. */
function serveFake(): Promise<void> {
  fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const [, host, ...rest] = (req.url ?? '/').split('/');
    const r = await f.fetchFn(`https://${host}/${rest.join('/')}`, { method: req.method, headers: req.headers as Record<string, string>,
      body: !buf.length ? undefined : host === 'uploads.github.com' ? new Uint8Array(buf) : buf.toString('utf8') });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise(r => fake.listen(0, '127.0.0.1', () => { fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`; r(); }));
}

/** The driver: plain Node, the bundle and nothing else. It answers each request in argv and prints the answers. */
const DRIVER = `
import { createServer } from 'node:http';
const [bundle, fake, steps] = process.argv.slice(2);
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(String(input));
  return /^(api|uploads)\\.github\\.com$/.test(u.host) ? real(fake + '/' + u.host + u.pathname + u.search, init) : real(input, init);
};
const { default: handler } = await import(bundle);
const server = createServer((req, res) => { handler(req, res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const out = [];
let cookie = '';
for (const s of JSON.parse(steps)) {
  const r = await real(base + s.path, { method: s.method ?? 'GET', headers: { ...(cookie ? { cookie } : {}), ...(s.body ? { 'content-type': 'application/json' } : {}) }, body: s.body ? JSON.stringify(s.body) : undefined });
  const text = await r.text();
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  out.push({ path: s.path, status: r.status, body: text });
}
server.close();
console.log(JSON.stringify(out));
`;

beforeAll(async () => {
  const dist = tempDir();
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Gold Finder</title>');
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app.js'), '');
  built = await buildVercel(undefined, { out: join(tempDir(), 'output'), dist, log: () => {} });
  await serveFake();
  // The cloud as the hourly run leaves it: one flip, one setting, Chip's "I did this", all published.
  const dir = tempDir();
  const db = openDb(dir);
  const detail = { key: 'f1', name: 'Bandage', itemId: 100, perItem: 300, best: { units: 5, cost: 1000, expectedProfit: 1500 }, options: [] };
  db.prepare(`INSERT INTO flips (key, kind, family, house_id, item_id, state, expected_profit, risk, detail, first_seen, last_seen, data_at) VALUES ('f1', 'craft', 'craft_auction', 1, 100, 'live', 1500, 'low', ?, 1, 1, 1)`).run(JSON.stringify(detail));
  db.prepare(`INSERT INTO settings (key, value) VALUES ('alert_good_gold', '10')`).run();
  await putJson(store, RESULTS_KEY, JSON.stringify({ flips: [{ key: 'f1', detail }], run: null, heldBack: [] }));
  await putJson(store, LEDGER_KEY, ledgerFile(db));
  db.close();
  await pushDb([{ store, keep: 2 }], dir);
}, 60_000);
afterAll(() => new Promise<void>(r => fake.close(() => r())));

describe('the Vercel build output', () => {
  it('has the static app, one bundled function with its config, and routes /api/* to it with an SPA fallback', () => {
    expect(existsSync(join(built.out, 'static', 'index.html'))).toBe(true);
    expect(existsSync(join(built.out, 'static', 'assets', 'app.js'))).toBe(true);
    expect(JSON.parse(readFileSync(join(built.out, FUNC, '.vc-config.json'), 'utf8'))).toEqual({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 60, shouldAddHelpers: false });
    const cfg = JSON.parse(readFileSync(join(built.out, 'config.json'), 'utf8'));
    expect(cfg.version).toBe(3);
    expect(cfg.routes.map((r: Record<string, string>) => r.src ?? r.handle)).toEqual(['^/api/(.*)$', 'filesystem', '^/(.*)$']);
    expect(cfg.routes[2].dest).toBe('/index.html');
    expect(readFileSync(join(built.out, FUNC, 'docs', 'CHANGELOG.md'), 'utf8').length).toBeGreaterThan(0);
    const code = readFileSync(built.bundle, 'utf8');
    expect(code).not.toMatch(/from\s*["'][^"']*\.ts["']/); // no TypeScript import left
    expect(code).toMatch(/["']node:sqlite["']/); // the builtins stay outside the bundle
    expect(built.bundleBytes).toBeLessThan(3e6);
  });

  /** Run the steps in a fresh plain Node process; each answer as status and parsed body. */
  async function drive(steps: Array<{ path: string; method?: string; body?: unknown }>, extra: Record<string, string | undefined> = {}) {
    const env = { PATH: process.env.PATH ?? '', DATA_KEY: KEY.toString('base64'), GITHUB_TOKEN: f.token, GITHUB_REPO: REPO, SITE_PASSWORD: 'pw', SESSION_SECRET: 'sec', TMPDIR: tempDir(), ...extra };
    const driver = join(tempDir(), 'driver.mjs');
    writeFileSync(driver, DRIVER);
    const { stdout } = await run(process.execPath, [driver, pathToFileURL(built.bundle).href, fakeUrl, JSON.stringify(steps)], { env, timeout: 60_000 });
    return (JSON.parse(stdout.trim().split('\n').at(-1)!) as Array<{ status: number; body: string }>).map(o => ({ status: o.status, body: JSON.parse(o.body) }));
  }
  const LOGIN = { path: '/api/login', method: 'POST', body: { username: 'Chip', password: 'pw' } };

  it('loads in plain Node; signed out and signing in cost no GitHub call', async () => {
    const before = f.calls.length;
    const out = await drive([{ path: '/api/me' }, { path: '/api/flips' }, { path: '/api/login', method: 'POST', body: { username: 'Chip', password: 'bad' } }, LOGIN, { path: '/api/me' }]);
    expect(out.map(o => o.status)).toEqual([200, 401, 401, 200, 200]);
    expect(out[0]!.body).toEqual({ authRequired: true, username: null });
    expect(out[4]!.body).toEqual({ authRequired: true, username: 'Chip' });
    expect(f.calls.length).toBe(before);
  }, 90_000);

  it('signed in, reads the sealed release and writes sealed inbox events, as the tests of the handler do', async () => {
    const out = await drive([LOGIN, { path: '/api/flips' }, { path: '/api/settings' }, { path: '/api/index?wowf_path=settings' },
      { path: '/api/flips/f1/did', method: 'POST', body: { units: 2 } }, { path: '/api/ledger/1/sold', method: 'POST', body: { units: 1, received: 500 } }, { path: '/api/changelog' }]);
    expect(out[1]!.body).toMatchObject({ online: true, flips: [{ key: 'f1' }] });
    expect(out[2]!.body.alert_good_gold).toBe('10');
    expect(out[3]!.body.alert_good_gold).toBe('10');
    expect(out[4]).toMatchObject({ status: 202, body: { pending: true, expectedProfit: 600 } });
    // Sold on the "I did this" saved a moment ago: judged after it, so it is accepted at once.
    expect(out[5]).toMatchObject({ status: 202, body: { pending: true } });
    expect(out[6]!.body.markdown.length).toBeGreaterThan(0);
    // The Sold names the "I did this" by its event, not by the row id guessed on the site copy.
    const did = out[4]!.body.event as string;
    expect((await readEvents(store)).map(e => [e.ev!.user, e.ev!.url])).toEqual([['Chip', '/api/flips/f1/did'], ['Chip', `/api/ledger/${did.slice(7, -5)}/sold`]]);
  }, 90_000);

  it('without DATA_KEY every call answers 500 with a plain message, and never crashes the function', async () => {
    const before = f.calls.length;
    const out = await drive([{ path: '/api/me' }, LOGIN, { path: '/api/flips' }], { DATA_KEY: '' });
    expect(out.map(o => o.status)).toEqual([500, 500, 500]);
    for (const o of out) expect(o.body).toEqual({ error: 'The site is missing DATA_KEY; see setup guide' });
    expect(f.calls.length).toBe(before);
  }, 90_000);
});
