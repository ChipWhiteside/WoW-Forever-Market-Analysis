# Agent prompts to relaunch the flip engine build

These are the prompts the build agents ran with when work stopped on November 24, adapted so a fresh session can launch them as is. Replace `<SCRATCH>` with the new session's scratchpad directory and `<REPO>` with the repo path. Launch each build agent with the Agent tool, `isolation: "worktree"`, `run_in_background: true`. Testers run without isolation and must not edit code.

Order: 1 and 2 can run in parallel (different files). 3 runs after 1 finishes and is merged. 4 and 5 test what 1 and 2 produce; repeat each tester until 3 clean rounds (Chip's rule: at least 3 independent checks per piece and 3 on the whole).

Agents that ran and finished (not needed again): static game data build (merged), game data tester round 1 (passed), flip core tester round 1 (findings are in prompt 2).

---

## 1. Sale counting (resume)

```
You are building one part of the WoW Forever flip engine: how the tool infers sales from hourly auction snapshots. Repo: the git worktree you start in. If node_modules is missing: `ln -s <REPO>/node_modules node_modules`.

FIRST: a previous run of this task was stopped midway. Its work is saved in docs/handoff/sale-counting-wip.patch (a diff against commit 39a8dda). Apply it: `git apply --3way docs/handoff/sale-counting-wip.patch`, resolve any conflict in docs/verification.md by keeping both sides, run `npm test`, and read the diff fully before continuing. Then finish and verify everything below; do not assume the saved work is correct.

Read first, fully: CLAUDE.md (binding rules), docs/flip-plan.md (approved plan; your part: section 3 holes 11 to 13, section 4 "New data the engine must start recording" items 1, 2, 5, section 6 "Refinements from the first independent test", "How many Chip can sell" and "Catching the opening", section 8 sale counting row, section 9 sale counting row), docs/verification.md B17 to B19, src/analysis/aggregate.ts, src/analysis/history.ts, src/engine/collector.ts, src/engine/rebuild.ts, src/engine/rawstore.ts, src/detectors/types.ts (Demand), src/flips/types.ts (SellQuote fields you feed), src/store/db.ts migration 11 (columns: item_stats.sweep_high, sold_units, new_near_floor; table listing_seen). Do NOT edit migrations; if you need a schema change, stop and report it. Scope: src/analysis/aggregate.ts, src/analysis/history.ts, src/engine/collector.ts, src/engine/rebuild.ts, src/detectors/types.ts (additive fields on Demand only), tests/unit/*, tests/sim/*, docs/verification.md (append rows). Do not touch src/flips, src/datasets, src/catalog, web/.

Background: Blizzard publishes each house's full listing snapshot about hourly (all houses near :25). No sales data exists anywhere; sales are inferred from listing id set differences between consecutive snapshots. Equipment auctions are quantity 1, buyers pick a listing. Commodities fill cheapest first through a buy window and partial buys shrink a listing's quantity. Forever listing lengths are 2, 8 and 24 hours; time_left buckets are SHORT, MEDIUM, LONG, VERY_LONG (mapping unverified: measure it from real data by the bucket a listing has when first seen and how long it survives).

Known faults to fix (verified in code at 39a8dda):
- aggregate.ts treated every vanished SHORT or MEDIUM listing as expired. A 2 hour listing is under 2 hours from the moment it is posted, so every 2 hour listing that sold was discarded. Fix with listing age: first seen time and first time_left per listing id (table listing_seen, or an in memory map rebuilt from raw snapshots on start; justify the choice). For commodities use fill order too: a vanished listing priced at or under the price up to which cheaper listings were all consumed is far more likely bought than expired.
- Only units within 10% of the previous floor were counted. Count full commodity sweeps where the fill order rule says units were bought; record sweep_high (highest unit price judged bought) per item.
- Cancel and relist matching only ran on markets with 5 or fewer listings. Detect cancel and undercut on deep markets too (vanished listing replaced by a new one of the same quantity at a lower or similar price), without erasing real restocking.
- Hourly sanity bound per item: units judged sold never exceed previous units + new units minus current units; log breaches as suspected bugs.
- Write item_stats.sold_units, sweep_high, new_near_floor (new units posted at or under 1.1x the floor).
- Demand (history.ts): keep existing fields; add saleEvents (count of vanished or shrunk listings judged sold over the window), unitsPerEvent (mean), lowPerDay = one sided ~95% Poisson lower bound on the EVENT count times unitsPerEvent, scaled to a day by hours watched, and null under 6 hours watched; newPerDay from measured new_near_floor (else new_units); hoursWatched; sweepHigh (last hour); low3d (lowest hourly floor in 3 days). Reason: Clam Linguine had 3 listings vanish (stacks 221, 48, 15 = 284 units); a bound over units gave a false ±6% band, over 3 events the honest bound is tiny.
- rebuild.ts re-counts stored raw history with current rules on start; make it use the new rules and listing ages.
- Chip's own trades: no data source yet. Leave a clear hook (a settings key of listing or item ids to exclude) and say so.

Simulator (tests/sim/): synthetic hourly snapshot sequences with known truth for aggregate() only: 2/8/24 hour posts, buys filling cheapest first (commodities) or picked (equipment), sweeps, undercut cancels and reposts, plain cancels, expiries, post and sell inside one hour. Seeded. Report bias and error of sold units per market type (deep commodity, thin commodity, equipment), old rules vs new, with pass marks you justify; a vitest test asserting them and a script printing the table.

Real data: raw snapshots (gzipped JSON, see rawstore.ts) in the data dir the coordinator names; read only any directory a running collector owns. Use them to measure the time_left mapping (record evidence), compare old vs new counts on Copper Ore 2770, Linen Cloth 2589, Frilled Lichen 249399, Empty Vial 3371, Clam Linguine, Truesilver Bar 6037, Poached Sunscale Salmon, Savory Turtle Stew plus 10 busy items, check the sanity bound never breaches, and print one real record of each kind before relying on fields (ledger rule 1).

Check three times: (1) unit tests and simulator pass, (2) real snapshot numbers are sane and every zero or empty is explained, (3) re-read your diff fresh against this brief. Existing tests whose expectations change because a rule intentionally changed: update them and say why. `npm test` and `npx tsc --noEmit` clean. Append verification rows (check the last B number). Prose for Chip: short sentences, no em dashes or hyphens. Commit on your worktree branch, message ending with the attribution lines from the session's system reminder. Do not push. Report: branch, commit, per file changes, the simulator table, real data comparisons, time_left evidence, anything unresolved.
```

## 2. Flip core, round 2 fixes (resume)

```
You are fixing the core of the WoW Forever flip engine after an independent test. Repo: the git worktree you start in (must contain commit 362389d or later from branch claude/gifted-albattani-10p08n; if not, `git merge claude/gifted-albattani-10p08n`). If node_modules is missing: `ln -s <REPO>/node_modules node_modules`. If the sale counting work (prompt 1) is merged on that branch, merge it first and use its Demand fields.

FIRST: a previous run was stopped just after starting. Apply docs/handoff/flip-round2-wip.patch (`git apply --3way`; diff against 362389d: src/flips/poisson.ts new, src/flips/inputs.ts, src/rules/flips.ts), read it, then complete the list.

Read: CLAUDE.md, docs/flip-plan.md (sections 0, 5, 6 including "Refinements from the first independent test", 7, 9), src/flips/*.ts, src/rules/flips.ts, tests/unit/flips*.ts, src/flips/types.ts (add fields only). Scope: src/flips/*, src/rules/flips.ts, tests/unit/flips*. Do not edit db.ts migrations, src/datasets, src/catalog, src/analysis, web/.

Round 1 of independent testing matched an independent Python recompute to the copper on 13 flips. The market model failed. Fix all of this:
H1 an auction-sold flip must not rank until its product has at least 6 hours of watched sales (held back, code learning, "learning: N of 6 hours of sales seen"). Low estimate over sale EVENTS, not units: Poisson one-sided ~95% lower bound on events times mean units per event. Use Demand.saleEvents, unitsPerEvent, lowPerDay, newPerDay, hoursWatched when present; else derive from item_stats (gone_listings for events, new_near_floor else new_units for new posts). Delete the 25%-of-sales fallback for new posts.
H2 newOvernight from measured new units near or under the floor per hour times horizon.
H3 risk: low3d falls back to the 25% drop (RISK.unknownLowDrop) until 72 hours are covered, using the observed low only when lower. Bad case = price at that low AND only half the expected sold actually sells (SALES_SHORTFALL 0.5 in rules/flips.ts with a comment). atStake and the gold cap include deposits for every unit posted. Risk driver when the floor fell over 10% this hour or new units per hour exceed sales per hour ("price war: floor fell X% this hour, N new listings an hour"). Levels: high when bad case loss > expected profit, medium when > half, else low. (Round 1: all 232 flips were low with bad case 0; 17 of the 22 top auction flips lost money at half capacity; Truesilver Bar went to minus 76g at half capacity because 261 bars carry 156g of deposits.)
H4 smooth chance of sale: overnight sale events Poisson with mean from the middle estimate minus new posts competing ahead (floored at 0), events carry unitsPerEvent; P(unit k sells) = P(enough events to reach k). Expected profit sums P_k x net + (1 - P_k) x (salvage - deposit) - cost_k. The best quantity stops before capacity when deposits are large.
M1 fresh gate: newest snapshot of a Chip house older than 2 hours before now makes the run incomplete ("data is N hours old").
M2 the lowerBound memo depends on evaluation order (market.ts around line 155): never memoize a result computed under a depth cut or a cycle; add a synthetic chain test (recipe Q listed regardless of order).
M3 cheap_listing: unbought units under the line count as ahead.
M4 setup: match teaching items with any prefix (Recipe:, Pattern:, Plans:, Formula:, Schematic:, Blueprint:, Manual:), better via wago ItemEffect teach spells if src/datasets/gamedata.ts exposes it; include the recipe item's auction price when listed (Recipe: Transmute Life to Earth 45g, Blueprint: Tanning Rack 7g50). Trainer rows with spell_id null match by name. Setup rank = recipes.learn_skill.
L1 vendor unit price from price_by_standing per units_per_purchase exactly (Rough Arrow 200 for 10c; Shiny Red Apple 5c).
L2 keep salvage (vendor sell price minus lost deposit) in expected profit; decided.
L3 openHours72 must not double count and must cap at 72.
L5 CLI picks snapshots at or before --now; a house missing one listing kind makes the run incomplete, never silently partial.
L6 cap the most row at MAX_UNITS.
Add a test per item. Real data: use the data dir the coordinator names (static data must be the new shape: recipes.live filled, bonding set). Check three times: tests, a real data run printing the top 25 with claim/net, low a day, new overnight, units, cost, each, expected, minutes, risk, strength, after shared and expected profit at half capacity, then a fresh re-read of your diff. Commit on your branch (not pushed) with the session's attribution lines and report.
```

## 3. Tester template for sale counting (run 3 rounds)

```
Independent verification, round N, of sale counting for the WoW Forever flip engine. You did not write it; find what is wrong. Read only: do not edit code or commit; scripts only under <SCRATCH>/testB<N>/.
Code: the branch or worktree the coordinator names; read the diff against 39a8dda. Spec: docs/flip-plan.md holes 11 to 13 and section 6 refinements, CLAUDE.md.
Do: npm test and npx tsc --noEmit; write your OWN sale counter (python -I) over the raw snapshots and compare sold units, sweep_high and new_near_floor per item per hour for 30 items (deep commodity, thin commodity, equipment); check the sanity bound on every item and hour; rerun the simulator with 5 new seeds and report bias and error; check the time_left mapping evidence; check Demand.lowPerDay is event based and null under 6 hours; read the diff for bugs (cancel and undercut detection erasing real restocks, partial buys, listing_seen growth and pruning, rebuild correctness, performance on 200k listings).
Report prioritized defects (severity, evidence, file:line, fix) and what you verified correct with counts.
```

## 4. Tester template for the flip core (rounds 2 and 3)

```
Independent verification, round N, of the flip engine core for a WoW Forever auction house tool. You did not write it; find what is wrong. Do NOT edit the code or commit; scripts only under <SCRATCH>/testC<N>/.
Code: the branch or worktree the coordinator names. Spec: docs/flip-plan.md sections 0, 5, 6 (binding) and src/flips/types.ts. Real data dir: the one the coordinator names (copy before running; CLI `DATA_DIR=<copy> npx tsx src/flips/cli.ts --top 50 --json out.json`).
Do: (1) npm test, npx tsc --noEmit. (2) Independent recompute in your OWN code (python -I or plain node, not importing src/flips) from the raw gz snapshot and sqlite: for 10 of the top 25, reagent cost for the stated units by walking real listings and vendor prices, claim price, net after the cut, chance weighted expected profit, risk bad case; report every disagreement over 1%. (3) Adversarial: for each of the top 15, argue why it is a bad flip in the real game (one hour of sales, a price war, troll or stale prices, unbuyable reagent depth, cooldowns, deposits, bind on pickup, an unlearnable or expensive recipe, a Horde or rep gated vendor) and check each argument against the data; report the ones you win. (4) Spec compliance: only Chip's houses; raw listings on the cost side with no junk gates; crafting not penalised by effort; 30 minute session cap; smooth chance of sale; half capacity bad case; deposits in gold at stake; learning gate at 6 hours; fresh gate; shared pass never over hands or raises numbers; incomplete runs produce no list. (5) Edge cases in code: zero prices, bid only listings, bundles, yield over 1, cycles, NaN or Infinity, huge quantities, performance.
Report prioritized defects (severity, evidence, file:line, fix), adversarial wins, and what you verified correct with counts. Blunt and concrete.
```

## 5. Whole system rounds 1 to 3 (after merge)

```
Independent whole system verification, round N, of the WoW Forever flip engine on branch claude/gifted-albattani-10p08n. Do not edit code. You may write test files under <SCRATCH>/sys<N>/ and propose test code in your report.
Run the real engine on a copy of the live data dir the coordinator names. Check: (1) end to end goldens on real recorded snapshot sequences with prices injected through the whole pipeline (aggregate, demand, flips; nothing stubbed): Cerulean Dye (2 Frilled Lichen at 25 to 30s, Empty Vial 20c per 5 from a vendor, dye selling 70 to 80s with real sales) lands in the top 10 as a green craft; Bright Baubles (vendor 250c, Blackwater near 5s, 15% cut) shows or not purely from its stated sales; today's real prices hold both back with a plain reason; near misses: Lichen at 36s (gone), dye selling 1 a day (weak or gone), one troll dye at 5g and a three listing troll (price unchanged); junk stays out: Lionheart Helm on 3 listings, transmute chains past their cooldown, bind on pickup, random yield. (2) Independent recompute of the top 25. (3) Paper trade backtest if 24 hours or more of history exist: for each flip shown at hour T, buy at the T+1 ladder, sell only after units ahead clear; report realised over claimed by risk level, and misses among held back flips. (4) Rank stability hour to hour. (5) The Flips page: build (npm run build:web), serve, screenshot with Playwright at desktop and phone width, and check every element in docs/page-contracts.md for the Flips page is present and readable.
Report defects with evidence and what passed.
```
