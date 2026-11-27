# Brief: phase 2 on GitHub storage (Chip, November 27: free, data in GitHub)

Supabase is out: its free tier cannot carry the engine database (measured at 33 MB gzipped and growing about 0.4 MB an hour). Everything the cloud needs lives in GitHub. Update docs/phase2-plan.md to this design and remove the Supabase parts.

## Design
1. **Engine database between hourly runs.**
   - The primary copy sits in the **Actions cache**, saved under a new key each run and restored by prefix.
   - The durable copy is an asset on a GitHub **release named `data`**: `wowf-<publish time>.db.gz`. Upload the new asset first, then delete the old one. Keep the newest 2.
   - The job restores from the cache, else from the newest release asset, else starts fresh. The datasets (wago, EG Link) are cached the same way.
   - The raw snapshots needed for the 72 hour windows (newPosts and rebuild) stay in the cache, pruned to what the engine needs (26 hours as now). No raw snapshots go in releases.
2. **`results.json`** (the /api/flips payload) and a small `ledger.json` are published as release assets too, overwritten each run. That way the site reads small files without opening the database.
3. **GitHub blob store** (`src/cloud/githubStore.ts`).
   - It implements BlobStore over the REST API: release assets for objects, and the contents API on a branch `data-inbox` for small JSON event files.
   - It uses fetch only, with `Authorization: Bearer ${GITHUB_TOKEN}`.
   - It needs no lock: the Actions concurrency group serialises every run, and the site never writes the database.
   - Remove supabaseStore.ts and its tests. Keep localStore for local mode and tests.
4. **Writes from the site** (I did this, Sold, settings, house pins) become small event files committed to `data-inbox/events/<time>-<user>-<random>.json` through the contents API.
   - The hourly job applies the new events to the database in order, idempotently by file name, then deletes them, or moves them to `applied/` and prunes them.
   - The Ledger page shows the published ledger.json plus any events not applied yet, marked "saved, counts at the next update".
5. **Refresh** triggers `workflow_dispatch` on the collect workflow through the API and returns 202.
   - The page shows "Running on GitHub, usually 1 to 2 minutes", polls the run's status, then reloads results.json.
   - If a run is already queued or in progress, it joins that run instead of starting another.
6. **Vercel function** (api/index.ts).
   - Read only for the database: download the newest db asset into /tmp, cached by asset id across warm calls, and serve the existing routes through buildServer and inject.
   - Writes go to inbox events.
   - Login stays as built.
   - Reconcile the names: one module owns the store, the database key and the publish and pull helpers. The current branch does not typecheck because api/index.ts and vercelHandler.ts expect `storeFromEnv`, `runCloudCycle` and `CloudEnv` from src/cloud/run.ts. Fix it properly: no shims, no duplicated logic.
7. **Retention**, so the database stays small:
   - The cloud collects only Chip's houses.
   - Hourly item_stats are kept 30 days in the cloud, with daily rollups forever.
   - Measure the database size after a simulated 30 days, and say what retention keeps it under 150 MB uncompressed.
8. **Workflow** (`.github/workflows/collect.yml`).
   - Cron at :28, plus workflow_dispatch, with a concurrency group (cancel-in-progress false).
   - Permissions: `contents: write` (releases and inbox) and `actions: read`.
   - Steps: Node 22, npm ci, cache restore, `npm run cloud:run`, cache save.
   - Secrets: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET, DISCORD_WEBHOOK_URL. Variable: APP_URL. GITHUB_TOKEN is built in.
   - Note that GitHub only runs cron from the default branch.
9. **Setup guide** (`docs/setup-online.md`), click by click for Chip, plain words, no hyphens or em dashes:
   - Merge to main.
   - Repository secrets.
   - A fine grained token for Vercel with access to this repo only: Contents read and write, Actions read and write.
   - Import into Vercel and set the environment variables SITE_PASSWORD, SESSION_SECRET, GITHUB_TOKEN and GITHUB_REPO.
   - Add gold.chipwhiteside.com in Vercel.
   - The first run (dispatch it by hand) and how to tell it worked.
   - What it costs: free. Actions minutes on a private repo are about 1,100 of the 2,000 free a month; they are unlimited if the repo is public.

## Tests
- githubStore with a mocked fetch: asset upload then delete, list, get by newest, inbox commit, delete, conflicts and retries, and errors from rate limits.
- A full cloud cycle against localStore:
  - restore from nothing;
  - restore from a release asset when the cache is absent;
  - events applied once and idempotent;
  - results.json and ledger.json published.
- The Vercel handler:
  - GET routes come from the downloaded database;
  - a write becomes an event;
  - Refresh dispatches or joins a run;
  - login is required.
- Page contract tests for the Refresh running state and pending ledger rows, both additive.

Finish: npm test, tsc for server and web, and build:web clean. Commit early on your branch, do not push. Put measurements in scratchpad/findings-phase2-github.txt. Report in at most 300 words, including the number of tests added.
