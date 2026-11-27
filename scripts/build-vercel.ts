/**
 * `npm run build:vercel`: the site for Vercel in the Build Output API v3 layout, so Vercel deploys exactly what this
 * builds and compiles nothing itself (vercel.json buildCommand, framework null):
 * - .vercel/output/static                       the web app (npm run build:web first)
 * - .vercel/output/functions/api/index.func     one esbuild bundle of src/cloud/vercelEntry.ts (index.mjs, ESM,
 *                                               node22, node: builtins external), docs/CHANGELOG.md, .vc-config.json
 * - .vercel/output/config.json                  /api/* to the function, then the static files, then index.html
 * tests/e2e/vercel-build.test.ts runs this, imports the bundle in plain Node and calls its handler.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/config/env.ts';

export const OUT = '.vercel/output';
export const FUNC = 'functions/api/index.func';

/** `out` and `dist` default to .vercel/output and web/dist; tests build into a temp folder. */
export async function buildVercel(root = PROJECT_ROOT, opts: { out?: string; dist?: string; log?: (m: string) => void } = {}): Promise<{ out: string; bundle: string; bundleBytes: number }> {
  const log = opts.log ?? console.log;
  const out = opts.out ?? resolve(root, OUT);
  const dist = opts.dist ?? join(root, 'web', 'dist');
  if (!existsSync(join(dist, 'index.html'))) throw new Error('web/dist is missing: run npm run build:web first');
  rmSync(out, { recursive: true, force: true });
  cpSync(dist, join(out, 'static'), { recursive: true });

  const func = join(out, FUNC);
  await build({
    entryPoints: [join(root, 'src', 'cloud', 'vercelEntry.ts')],
    outfile: join(func, 'index.mjs'),
    bundle: true, format: 'esm', platform: 'node', target: 'node22',
    external: ['node:*'],
    // Bundled CommonJS packages (fastify and its parts) call require for builtins; ESM has none, so give it one.
    banner: { js: "import { createRequire as __wowfRequire } from 'node:module'; const require = __wowfRequire(import.meta.url);" },
    define: { 'process.env.WOWF_BUNDLED': '"1"' },
    minify: true, legalComments: 'none', logLevel: 'warning',
  });
  mkdirSync(join(func, 'docs'), { recursive: true });
  cpSync(join(root, 'docs', 'CHANGELOG.md'), join(func, 'docs', 'CHANGELOG.md'));
  writeFileSync(join(func, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 60, shouldAddHelpers: false }, null, 2));
  writeFileSync(join(out, 'config.json'), JSON.stringify({
    version: 3,
    routes: [
      // wowf_path names the original path, in case the function sees /api/index (src/cloud/vercelEntry.ts).
      { src: '^/api/(.*)$', dest: '/api/index?wowf_path=$1' },
      { handle: 'filesystem' },
      { src: '^/(.*)$', dest: '/index.html' },
    ],
  }, null, 2));
  const bundleBytes = statSync(join(func, 'index.mjs')).size;
  log(`build:vercel: ${out} written; function bundle ${(bundleBytes / 1e6).toFixed(2)} MB`);
  return { out, bundle: join(func, 'index.mjs'), bundleBytes };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(PROJECT_ROOT, 'scripts', 'build-vercel.ts')) {
  buildVercel().catch(e => { console.error(e); process.exit(1); });
}
