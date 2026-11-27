# Phase 2: online at gold.chipwhiteside.com

November 27, 2026. Chip's decisions:
- Vercel for the site, GitHub Actions for the hourly collector, GitHub for storage. Free.
- A shared password plus a free text username. The site remembers the login, and every action records who took it.
- The address is gold.chipwhiteside.com.
- Local mode keeps working.

Supabase is out: its free tier cannot carry the engine database. The repository is public, so everything the cloud stores is encrypted.

## Design: the same tested engine, its files in GitHub
The engine keeps its SQLite database (`wowf.db`). Rewriting it for another database would redo most of what the tests prove.

1. **Encryption** (`src/cloud/crypto.ts`). Every stored object is sealed with AES 256 GCM. The key is `DATA_KEY`, 32 random bytes in base64, kept as a repository secret and as a Vercel variable. Without it the cloud refuses to start. A wrong key or a changed byte is an error, never wrong data.
2. **Blob store** (`src/cloud/store.ts`). One small interface: get, put, delete and list. Two implementations:
   - the local folder (`localStore.ts`): local mode, the Actions cache folder, tests;
   - GitHub (`githubStore.ts`) over the REST API with fetch only: assets on a release named `data` for objects, and files on a branch named `data-inbox` for the site's writes.
   There is no lock. The Actions concurrency group runs one cycle at a time, and the site never writes the database.
3. **Layout** (`src/cloud/layout.ts`) owns the names and the moves:
   - `wowf-<publish time>.db.gz`: the database, gzipped and sealed. The new asset goes up first, then the old one is deleted. The newest 2 stay.
   - `results.json`: the /api/flips payload. `ledger.json`: every ledger row and the events already applied. Both are overwritten each run.
   - `events/<time>-<random>.json` on `data-inbox`: one per write from the site. The name never holds the username.
4. **Hourly cycle** (`src/cloud/run.ts`, `npm run cloud:run`):
   1. Restore the database from the Actions cache, or from the newest release asset when the cache is missing or older, or start fresh.
   2. Wait for Blizzard's publish (not for Refresh).
   3. Apply the inbox events in name order, through the same routes the local app uses, signed in as each event's person. Each name is applied once (kv `inbox_applied`).
   4. Poll Chip's houses only, collect, count sales, run the flips and their alerts: the existing Engine.
   5. Publish the database, results.json and ledger.json, and the sealed copy in the cache. Then delete the applied events.
   6. Once a day, the dataset refresh with cloud retention, then publish again.
   The plain database never stays in the cache folder.
5. **Hourly job** (`.github/workflows/collect.yml`). Cron at 28 past, plus workflow_dispatch for Refresh. A concurrency group that never cancels. Permissions: contents write, actions read. Steps: Node 22, npm ci, cache restore, the cycle, cache save. The cache holds the sealed database, the raw snapshots for the 72 hour windows and the datasets. GitHub runs cron only from the default branch.
6. **Site on Vercel** (`src/cloud/vercelEntry.ts`, `src/cloud/vercelHandler.ts`).
   - `npm run build:vercel` writes Vercel's Build Output API folder: the static app, one esbuild bundle of the function and the routes. Vercel compiles nothing itself.
   - Login, logout and me touch no data. Every other request checks the cookie before anything reaches GitHub. After 5 wrong passwords from one address in 10 minutes, it waits 30 s.
   - The existing app is built as static files. One function wraps the existing Fastify server through `inject`.
   - GET /api/flips is results.json, GET /api/ledger is ledger.json plus the inbox. Every other GET reads the newest database asset, downloaded once per asset into /tmp.
   - A write (I did this, Sold, settings, house pins) is first tried on the site's copy and rolled back. A refusal answers at once. A success is saved as an inbox event and answers "Saved, counts at the next update."
   - The Ledger and the flip card show saved events until the next update applies them. Other pages replay saved events on a rolled back copy, so a saved pin or setting shows at once.
   - Refresh starts the workflow, or joins a run already queued or running, and answers 202. The page says "Running on GitHub, usually 1 to 2 minutes", or up to about 15 when it joins an hourly run waiting for Blizzard, follows the run, then reloads.
   - A write is judged after the saved writes before it, so Sold works right after "I did this". A saved write the cycle cannot apply is listed on the Ledger as "not applied: <reason>".
   - Flips shows a banner when the newest results are over 2 hours old, since GitHub turns off a public repository's schedule after 60 days without activity.
7. **Login.** A shared password, a free text username, an HttpOnly signed cookie for 90 days. Every write records the username. No key reaches the browser.
8. **People and the ledger.** "I did this" records units with the expected cost and profit. "Sold" records units and gold received. The Ledger page shows per person totals and a history. All additive.
9. **Retention**, measured on a copy of Chip's data (verification G8):
   - The cloud collects only Chip's houses.
   - Hourly item_stats cost 1.44 MB an hour for his two houses. 30 days would be 1.06 GB, so the cloud keeps 3 days (72 to 96 hours), which every flip window needs.
   - Daily rollups feed only the Market trends: the cloud keeps 30 days of them (about 23 MB), local mode keeps them forever. That holds the cloud database near 130 MB.
   - Raw snapshots stay in the cache for 98 hours. No local backups in the cloud.

## Setup
`docs/setup-online.md`, click by click.

## Testing
- Each piece has its own tests: the seal, the GitHub store against a fake REST API, the cycle, the handler.
- The pieces run together: the cycle against a sealed folder and against the fake GitHub, the handler against the fake GitHub.
- The first real run proves the GitHub endpoints (verification G1 to G7). Until then they are assumptions written down in the code.
