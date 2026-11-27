# Brief: phase 2, round 1 fixes

Detail is in scratchpad p2T1/findings.txt, and the probe is p2T1/probe.mts: reuse it. Keep the code tight and refactor in the context of the whole project.

1. **P1: the function must build and load.** Do not rely on Vercel compiling api/*.ts. Use Vercel's Build Output API v3:
   - `npm run build:vercel` writes `.vercel/output/static` (the web app) and `.vercel/output/functions/api/index.func`: one esbuild bundle (`index.mjs`, ESM, platform node, target node22, node:sqlite and the other node: builtins external) plus `.vc-config.json` (runtime nodejs22.x, handler index.mjs, maxDuration 60, launcherType Nodejs).
   - `.vercel/output/config.json` routes /api/* to the function and everything else to static, with an SPA fallback to index.html.
   - vercel.json sets buildCommand to `npm run build:vercel` and the framework to null.
   - Prove it here: a test that runs the build, then imports the bundled index.mjs in plain Node and calls the handler with a fake request against a fake GitHub (the probe's fake). Keep the bundle size reasonable and report it.
2. **P2: auth first.** /api/me, /api/login and /api/logout, and any request that is not signed in, must never touch GitHub (vercelHandler.ts:85,103). Check the cookie first. Add a login limit: after 5 failures from one IP in 10 minutes, wait 30 s. It is in memory and per instance, and that is fine.
3. **P2: public logs.** No event URL, flip key, item or house in the Actions logs (inbox.ts:85 and anywhere else). Log counts only.
4. **P2: writes see saved events.** Before trying a write on the site's copy, replay the saved inbox events, as GETs already do. Then Sold works right after "I did this", and two Solds over the units left are refused at once. The cycle must never drop a write silently: when an event fails on apply, the next ledger.json records it as "not applied: <reason>", and the Ledger shows that.
5. **P3:**
   - Bind every sealed object to its name, with the object key as AES-GCM additional data (crypto.ts:23), so a copied file fails to open.
   - The dbCache close race (dbCache.ts:36): count references, or keep the old handle until no request uses it.
   - A malformed cookie answers 401 and the login page, not a 500 (auth.ts:71).
   - /api/flips?gone=1: cap the gone rows at the 200 most recent, so the response stays well under 4.5 MB. Report the sizes.
   - Fix the run.ts:27-31 comment and verification row G8: Chip's coordinator decided 30 days of daily rollups in the cloud (docs/phase2-plan.md).
6. **Health banner.** The Flips page shows a plain banner when the newest results are over 2 hours old: "Hourly updates have not run since <time>. Check the Actions tab on GitHub." GitHub turns off cron in a public repo after 60 days with no repository activity. This is additive; update the page contract.
7. **Setup guide** (docs/setup-online.md):
   - Add the secrets before the merge.
   - The 60 day schedule note: how to turn it back on.
   - DISCORD_DEV_WEBHOOK_URL is optional.
   - Set the Vercel variables for Production.
   - Refresh can take up to about 15 minutes when it joins an hourly run waiting for Blizzard; make the page wording match.
   - Does creating the inbox branch need the Workflows permission? If unsure, have the workflow create the branch with its built in token and say so.

Finish: npm test, tsc for server and web, build:web and build:vercel clean. Commit early on your branch, do not push. Report in at most 300 words, including the tests added and the bundle size.
