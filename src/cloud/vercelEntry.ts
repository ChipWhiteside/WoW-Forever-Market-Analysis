/**
 * The one Vercel function (docs/phase2-plan.md). `npm run build:vercel` (scripts/build-vercel.ts) bundles this file
 * into .vercel/output/functions/api/index.func/index.mjs with the Build Output API, and .vercel/output/config.json
 * sends every /api/* request here. Nothing relies on Vercel compiling TypeScript. The logic lives in
 * src/cloud/vercelHandler.ts so tests run it through a plain node http server. It needs DATA_KEY, GITHUB_TOKEN and
 * GITHUB_REPO. Without DATA_KEY every call answers 500 with MISSING_DATA_KEY (everything stored is encrypted).
 *
 * Vercel limits this relies on. The Vercel docs could not be reached from the build session (November 27, 2026), so
 * these are assumptions to confirm on the first deploy (docs/verification.md P2D):
 * - Duration: Hobby allows up to 60 s per call (.vc-config.json maxDuration); a cold call downloads the database asset
 *   (about 35 MB) once.
 * - Request and response bodies are capped at 4.5 MB. /api/flips with 1,000 detailed rows must stay under it.
 * - /tmp is writable (about 500 MB) and survives between calls on a warm instance, which the asset cache uses.
 * - nodejs22.x runs node:sqlite without a flag.
 * - The function sees the original path in req.url after the route; if it sees /api/index instead, the route's
 *   wowf_path query names the original (originalUrl below).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeHandler } from './vercelHandler.ts';
import { storeFromEnv, githubFromEnv } from './layout.ts';

let handler: ReturnType<typeof makeHandler> | null = null;

/** The path the browser asked for: req.url as it is, or rebuilt from the route's wowf_path query. */
export function originalUrl(url: string): string {
  const [path, qs] = url.split('?') as [string, string | undefined];
  const q = new URLSearchParams(qs ?? '');
  const p = q.get('wowf_path');
  if (p === null) return url;
  q.delete('wowf_path');
  const rest = q.toString();
  return `${path === '/api/index' ? `/api/${p.split('/').map(encodeURIComponent).join('/')}` : path}${rest ? `?${rest}` : ''}`;
}

/** What every call answers when DATA_KEY is not set: fail closed, but say why (docs/setup-online.md Troubleshooting). */
export const MISSING_DATA_KEY = 'The site is missing DATA_KEY; see setup guide';

export default async function vercel(req: IncomingMessage, res: ServerResponse) {
  if (!process.env.DATA_KEY) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify({ error: MISSING_DATA_KEY }));
  }
  handler ??= makeHandler({ store: storeFromEnv(process.env), gh: process.env.STORE === 'local' ? null : githubFromEnv(process.env), env: process.env });
  req.url = originalUrl(req.url ?? '/');
  return handler(req, res);
}
