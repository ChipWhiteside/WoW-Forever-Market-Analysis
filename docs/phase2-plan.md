# Phase 2: online at gold.chipwhiteside.com

November 27, 2026. Chip's decisions:
- Vercel for the site, GitHub Actions for the hourly collector, Supabase for storage.
- A shared password plus a free text username. The site remembers the login, and every action records who took it.
- The address is gold.chipwhiteside.com.
- Local mode keeps working.

## Design: the same tested engine, its files in the cloud
Rewriting the engine for Postgres would redo most of what 413 tests prove. Instead, the engine keeps its SQLite database (`wowf.db`), and its files live in Supabase Storage.

1. **Blob store** (`src/cloud/store.ts`). One small interface: get, put, list, delete and a lock. It has two implementations: the local folder (tests and local mode) and Supabase Storage over its REST API, with no SDK.
2. **Cloud run** (`src/cloud/run.ts`). This is one hourly cycle:
   1. Take the lock.
   2. Pull `wowf.db` and the last 26 hours of raw snapshots for Chip's houses into a temp folder.
   3. Poll Blizzard, collect, count sales and run the flips and alerts, all through the existing Engine.
   4. Write `results.json` (the `/api/flips` payload).
   5. Push the database, the new raw snapshots and the results.
   6. Prune raw snapshots older than 14 days.
   7. Release the lock.

   The static datasets (wago, EG Link) refresh daily inside the same cycle and are cached in storage too.
3. **Hourly job** (`.github/workflows/collect.yml`).
   - The schedule is a few minutes after :25, with a concurrency group so runs never overlap.
   - It waits for the publish with If-Modified-Since for up to 15 minutes.
   - Secrets: Blizzard id and secret, Supabase URL and key, the Discord webhook, and the app URL.
   - Workflows run on the default branch, so this needs a merge or the branch set as default. The setup guide says so.
4. **Site on Vercel.**
   - The existing app is built as static files.
   - One serverless function wraps the existing Fastify server through `inject`, so every existing route works unchanged.
   - Reads use the database from storage, cached in the function's temp folder by ETag.
   - Writes (settings, Done, Sold, house pins) run under the lock and push the database back.
   - Refresh runs the cloud cycle inline, waiting up to 60 seconds, and answers 409 when the hourly job holds the lock.
5. **Login.**
   - A shared password, set as a Vercel environment variable.
   - A free text username.
   - An HttpOnly signed cookie that lasts 90 days.
   - Every write records the username.
   - The Blizzard and Supabase keys never reach the browser.
6. **People and the ledger.**
   - On a flip card, "I did this" asks for units and records them with the expected cost and profit.
   - "Sold" asks for units and gold received.
   - A Ledger page shows, per person: flips done, gold spent, gold made, realised against expected, and a history list.
   - All of this is additive: nothing on existing pages moves.
7. **Limits** (to confirm against current free tiers while building):
   - Supabase Storage 1 GB: the database plus 14 days of raw files for 2 houses (about 1 MB an hour).
   - Vercel functions: duration and the 4.5 MB response limit.
   - GitHub Actions minutes: about 2 minutes an hour.

## Testing
- Each piece gets 3 or more independent test rounds.
- The pieces then get 3 or more rounds together.
- The whole online system gets checked live against the real Supabase project once its key is in, then as a whole.
- Test counts are reported at the end.
