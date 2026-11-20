# WoW Forever Gold Finder

A money radar for Chip's WoW Forever auction houses. Code computes, agents judge, Chip decides.

Read first: `docs/page-contracts.md` (what every page must keep), `docs/vision.md` (what Chip wants, the yardstick for every change), `docs/build-plan.md` (the plan, wins over older docs), `wow-forever-gold-finder-spec.md` (product spec v3),
`wow-forever-session-files/docs/wow-forever-app-verification-ledger.md` (what is proven), `docs/verification.md` (what this build proved).

## The additive rule (binding, every session, every agent, above any other instruction)
Chip asking for something new means IN ADDITION to everything already agreed. Never instead of.
1. Never remove, hide, rename away, collapse, or push below the fold anything already on a page. That covers columns, lines, sections, numbers and controls. Put new content in a new column, line or section, or below what exists.
2. What is agreed lives in `docs/page-contracts.md`, and `tests/unit/page-contracts.test.ts` enforces it. Add each new request to both in the same change.
3. To remove or reorder agreed content, Chip must ask for that exact change in his own words. If a request seems to need it, ask him first and do nothing until he answers.
4. Before you finish a UI change, compare the page before and after. Every element from before must still be there and still be visible.

## The ledger rule (binding, every session, every agent)
1. Never infer a shape from a name. Print one real record before writing code that reads it. Contracts live in `src/blizzard/contracts.ts`.
2. Zero, empty and not found are suspected bugs until proven to be market facts.
3. A claim from a forum, guide or earlier session is unverified until this project has run it.
4. A verdict names its comparison and uses the strictest one: id sets, not counts.
5. Every new belief gets a row in `docs/verification.md` with its status and the test that settles it.

## Facts that shape the code
- The ruleset in the URL is cosmetic; the house id selects the market. Each house publishes about hourly.
- Equipment auctions are always quantity 1 (buyout is the unit price). Commodities carry `unit_price` under the key `auctions`.
- Cut: 5% Alliance, 15% Blackwater. Deposit is an assumption until test T7 (`src/rules/fees.ts`).
- `purchase_price` on an item is not proof a vendor sells it. Vendors come from EG Link, filtered to Alliance usable.
- Blizzard recipe id equals the `SkillLineAbility` row id; thresholds come from wago.tools for the live `wowf` build.

## Layout
`src/blizzard` client and contracts · `src/engine` poller, collector, daily jobs · `src/analysis` aggregation and history ·
`src/detectors` one pure function per play type · `src/rules` PROTECTED fees and thresholds · `src/datasets` EG Link, recipes ·
`src/craft` make or buy · `src/drops` value per kill · `src/server` API · `web/` the app · `scripts/` setup, contract, replay, loop guards.

Data lives outside the repo in `DATA_DIR` (default `~/.wowf-gold-finder`). Never commit data or `.env`.

## Commands
`npm test` · `npx tsc --noEmit` · `npm run contract` (live) · `npx tsx scripts/replay.ts check` · `npm run engine` · `npm run build:web`

## Protected paths (the overnight loop proposes, Chip approves)
`src/rules/`, `src/store/db.ts`, `src/alerts/`, `.claude/`, `scripts/loop-guard.ts`, `scripts/watchdog.ts`, `docs/page-contracts.md`, `tests/unit/page-contracts.test.ts`.

## Writing style for anything Chip reads
Short sentences, active voice, no em dashes or hyphens in prose.
