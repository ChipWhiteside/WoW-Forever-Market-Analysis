# Handoff: flip engine build, paused November 24 (usage limit)

Read this first when resuming. The exact agent prompts to relaunch are in `docs/handoff/agent-prompts.md`. Branch `claude/gifted-albattani-10p08n`. The approved plan is `docs/flip-plan.md` (section 0 holds Chip's decisions and wins over everything). Chip's standing order: at least 3 independent check rounds per piece and 3 on the whole, using subagents; work autonomously to the end; deliver a working app plus `docs/flips-tutorial.md`.

## Resumed November 25 (latest state, read this part first)
- Collector restarted on scratchpad/live (history from November 23 to 25 kept). The suspected stall was the daily vendor price refresh: it now logs start and end and finishes in about 148 s with 0 errors.
- Game data test round 2 done. Defects found: learn skill overstated (yellow fallback), teaching items matched by name only (119 of 206 craft flips had no learn source), poisons turned bind on pickup by hotfix (cross check ran too early), Korean names from EG Link, vendor standing gate too strict, Revered discount 0.85 should be 0.90, new build failure blocks the daily, Horde only neutral vendors. Migration 12 (18a827d) adds recipes.teach_item_id, teach_skill, learn_source.
- Running agents (relaunch with docs/handoff/agent-prompts.md if stopped; each commits early on its own worktree branch, so check `git worktree list` and merge what is committed): sale counting (prompt 1), flip core round 2 (prompt 2, also told to use teach_item_id for setup), game data round 2 fixes (the seven defects above, same scope as the original game data build).
- Next after they report: game data test round 3, sale counting test rounds 1 to 3, flip core test rounds 2 and 3, merge, whole system rounds 1 to 3, Flips page screenshots, tutorial.

## Done and on the branch
1. **Plan v2, approved.** Chip's decisions: crafting is first class; one list with green crafting and blue flipping cards; only Alliance 111 and his one Blackwater house (id still unknown, P6); no gold per hour floor, time rate 0; overnight horizon 10 h with no relisting; 30 minute craft session cap on the best amount; quantity table (small, best, most); risk per flip; local only for now (chipwhiteside.com later).
2. **Foundation** (39a8dda): migration 11 in `src/store/db.ts`, shared types in `src/flips/types.ts`.
3. **Static game data** (merged from agent A, a142cba): wago tables for build 1.60.1.71037 (`src/datasets/gamedata.ts`), recipes rebuilt and cross checked with Blizzard (`src/datasets/recipes.ts`), binding read from `preview_item.binding`, Classic item fallback for about 3,100 old items (`src/catalog/items.ts`), throttled client. **Test round 1 passed**: 2,233 of 2,233 recipes recomputed independently with 0 mismatches, 50 of 50 items match a live re-fetch. Follow ups D3 (Blizzard whole number yields) and D5 (Retry-After capped at 60 s) are done. Still open from that test: D2 (quest-class conversion items need listing evidence; the flip engine's sell gates cover it in practice), D4 (a transient item fetch error can silently mark a recipe not live).
4. **Flip core** (merged from agent C, d9b812a and b1a3545): `src/flips/*` (cost book, sell book, families, evaluate, run, persist, cli, hourly), `src/rules/flips.ts`. Wired into `Engine.detect()` through `src/flips/hourly.ts`; held back list saved in kv `flip_held_back`.
5. **Flips page** (`web/src/pages/flips.tsx`), `/api/flips` (`src/server/flips.ts`), first in the menu and the default page; page contract added in `docs/page-contracts.md` and `tests/unit/page-contracts.test.ts`.
6. On the branch at b30f783: 202 tests pass, typecheck clean (server and web).

## In progress when stopped (saved as patches, not merged)
### A. Sale counting (agent B): `docs/handoff/sale-counting-wip.patch`
Against 39a8dda. A commit (8298e99) plus uncommitted work: listing age expiry, commodity sweeps, undercut cancels on deep markets, sanity bound, simulator in `tests/sim/`, rebuild with new rules. Mid task: the event based low estimate. Brief it was given: flip-plan holes 11 to 13 and section 6; plus my follow up: **lowPerDay must be a Poisson lower bound (about 95%) over sale EVENTS times mean units per event, null under 6 hours watched; expose Demand.saleEvents, unitsPerEvent, newPerDay (from new_near_floor, else new_units), hoursWatched**. Its report was never delivered: the simulator table, the time_left mapping evidence and the old vs new counts on real items are unknown. Treat as unverified.
Apply: `git apply --3way docs/handoff/sale-counting-wip.patch` (expect conflicts in `docs/verification.md`; keep both sides), then `npm test`.

### B. Flip core round 2 fixes (agent C): `docs/handoff/flip-round2-wip.patch`
Against 362389d. Only started: `src/flips/poisson.ts` (new), `src/flips/inputs.ts`, `src/rules/flips.ts`. Full fix list it was working on, from test round 1 (an independent Python recompute matched 13 flips to the copper, then found these):
- **H1** auction flips need 6 hours of watched sales before ranking (held back "learning"); low estimate over sale events, not units (Clam Linguine's 1,025 a day came from 3 vanished stacks in one hour).
- **H2** new listings overnight from measured new units per hour; delete the 25% of sales fallback (it was 10 to 300 times too low).
- **H3** risk: low3d falls back to a 25% drop until 72 hours exist; bad case = that price and only half the expected units sell (SALES_SHORTFALL 0.5); deposits in gold at stake and the gold cap; price war driver (floor fell over 10% this hour or new units per hour above sales per hour); levels high when bad case loss > expected profit, medium when > half. All 232 flips were "low" with bad case 0.
- **H4** smooth chance of sale: Poisson over overnight sale events; expected profit sums P_k × net + (1 − P_k) × (salvage − deposit) − cost_k, so big deposits shrink the best amount (Truesilver: 1s 78c margin against a 60s deposit).
- **M1** fresh gate: newest snapshot over 2 hours old makes the run incomplete. **M2** lowerBound memo depends on evaluation order (`market.ts:155`); never memoize under a depth cut or cycle; add the chain test. **M3** cheap listing: unbought units under the line count as ahead. **M4** setup: match teaching items with any prefix (Recipe, Pattern, Plans, Formula, Schematic, Blueprint, Manual) and show their auction price; trainer rows with null spell_id match by name.
- **L1** vendor unit price from price_by_standing per units_per_purchase. **L2** keep salvage in expected profit (decided). **L3** openHours72 no double count, cap 72. **L5** CLI picks snapshots at or before --now; a house missing one listing kind is incomplete. **L6** cap most at MAX_UNITS.
Apply after A: `git apply --3way docs/handoff/flip-round2-wip.patch`, then finish the list with tests.

## Live collector
It was running from `scratchpad/live` (ephemeral, likely gone with the container). It had about 8 hourly publishes of all 8 houses. Restart it so history builds while work resumes:
```bash
DATA_DIR=<scratchpad>/live nohup setsid npx tsx src/engine/main.ts --no-server > <scratchpad>/live/engine.log 2>&1 < /dev/null & disown
```
Open question when stopped: after "recipes on start" the engine went quiet for 13+ minutes at 2% CPU with no database writes. The likely cause is the daily `vendor prices` step (`engine.refreshCatalog()` re-fetching about 10,000 items with no progress log), but it was not confirmed. Add a progress log there and confirm before trusting the engine. The first flip run on that data (before the round 2 fixes) ranked 302 flips in under 1 second.

## Remaining steps, in order
1. Apply patch A, finish the event based estimate, get its report items (simulator table with pass marks, time_left mapping evidence, old vs new counts for Copper Ore, Linen, Frilled Lichen, Empty Vial, Clam Linguine, Truesilver Bar, Poached Sunscale Salmon, Savory Turtle Stew). Then **independent test rounds 1, 2, 3** on sale counting (subagent with its own code path).
2. Apply patch B, finish H1 to L6 with tests. Then **flip core test rounds 2 and 3** (independent recompute of the top 25, adversarial "why is this a bad flip" on the top 15, half capacity check).
3. Merge, restart the collector, confirm the stall cause.
4. Whole system rounds 1 to 3 (task 5): end to end goldens on recorded snapshots with Chip's prices injected (Cerulean Dye in the top 10 at Ben's prices; Bright Baubles judged by its stated sales; both held back at today's prices; Lionheart Helm, cooldown chains, bind on pickup kept out); near misses (Lichen at 36s gone, dye selling 1 a day weak, troll dye at 5g ignored); independent recompute; paper trade backtest and rank stability once 24+ hours of history exist.
5. A screenshot review of the Flips page with real flips (`npm run build:web`, Playwright), checked against the page contract.
6. `docs/flips-tutorial.md`: how to start it locally and how to read a card. Then the final report to Chip.

## Facts proven this session (also in docs/verification.md B22 to B32, F1 to F10)
- Cerulean Dye 249409: Alchemy SLA 54453, 2 Frilled Lichen 249399 + 1 Empty Vial 3371, taught at Alchemy 40 for 1s 50c, cast 5 s. No quest needs it; about 130 recipes do.
- Bright Baubles 6532: Old Man Heming, Booty Bay, 250c.
- About 3,100 listed items are 404 on the Forever item API and 200 on Classic (`static-classic1x-us`).
- Transmutes share cooldown category 310; Mooncloth 95 h on its own; Iron to Gold 1 h.
- Live house 111 (November 23): about 120k equipment listings over 5,593 items, 92k commodity listings over 1,345 items.

## State at the November 26 limit stop (newest, read first)
- Merged and pushed: game data (3 test rounds done), sale counting round 1 fixes, flip core through round 5 (risk aware best amount; Cerulean Dye at Ben's prices: 22 crafts, medium risk, about 2g 87s; bad case model: tomorrow gets its own queue behind tonight's shortfall, accepted). 304 tests pass.
- In progress when stopped: sale counting round 2 fixes (agent was fixing a tie break and two tests); its work is in docs/handoff/sale-counting-round2-fixes.patch. Its brief: drop the equipment pull term; t bound on hourly units with the Poisson floor; expose Demand.hourlyMean, hourlySd and hourly hours (flip engine reads `hourlyHours`); dominant front reposter scenario and flag; netPerDay formula; out of sample seeds 301 to 312.
- Next: finish that, then sale counting test round 3 and flip core test round 3 (probe Timbermaw Brawlers at 464g and Felblood Soul Bag at 65g), then whole system rounds 1 to 3, Flips page screenshots, tutorial.
- **Chip's request for the restart: first assess how to do this work more token efficiently without losing depth or quality, then continue.**

## Build complete, November 26
Every piece passed at least three independent test rounds, and the whole system passed three rounds plus a polish round. 373 tests pass. The tutorial is `docs/flips-tutorial.md`. Open items for Chip are listed in `docs/flip-plan.md` under "In game checks for Chip". Known limit: this cloud session never holds 6 straight hours of history (worker restarts kill the collector), so live auction flips were validated by the end to end yardstick suite, the simulator and the backtest. On Chip's PC the engine runs continuously.

## Refresh button and alerts, November 27
Refresh button on the Flips page, quiet hourly collection, Discord alerts only for Good (10g) and Amazing (20g) flips that pass every evidence gate, no cap per hour, a 24 hour repeat rule with a 25% growth exception, old play alerts off by default. Three test rounds and a live recheck passed: exactly one post per alert under every race, at most the in flight post doubles after a crash, a second engine on the same data sends nothing, a hung webhook costs one 15 second wait per run. 413 tests pass. Phase 2 (Vercel, GitHub Actions, Supabase) is next when Chip says go.
