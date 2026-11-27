/**
 * The one Vercel function (docs/phase2-plan.md). vercel.json sends every /api/* request here; the logic lives in
 * src/cloud/vercelHandler.ts so tests run it through a plain node http server. It needs DATA_KEY, GITHUB_TOKEN and
 * GITHUB_REPO, and refuses to start without DATA_KEY (everything stored is encrypted).
 *
 * Vercel limits this relies on. The Vercel docs could not be reached from the build session (November 27, 2026), so
 * these are assumptions to confirm on the first deploy (docs/verification.md P2D):
 * - Duration: Hobby allows up to 60 s per call; a cold call downloads the database asset (about 35 MB) once.
 * - Request and response bodies are capped at 4.5 MB. /api/flips with 1,000 detailed rows must stay under it.
 * - /tmp is writable (about 500 MB) and survives between calls on a warm instance, which the asset cache uses.
 * - Node 22.x is available and node:sqlite works there without a flag from 22.13. package.json engines is
 *   ">=22.13"; set the project's Node version to 22.x in Vercel if it picks a newer major.
 * - The function sees the original path in req.url after the vercel.json rewrite.
 */
import { makeHandler } from '../src/cloud/vercelHandler.ts';
import { storeFromEnv, githubFromEnv } from '../src/cloud/layout.ts';

let handler: ReturnType<typeof makeHandler> | null = null;

export default async function vercel(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  handler ??= makeHandler({ store: storeFromEnv(process.env), gh: process.env.STORE === 'local' ? null : githubFromEnv(process.env), env: process.env });
  return handler(req, res);
}

export const config = { maxDuration: 60 };
