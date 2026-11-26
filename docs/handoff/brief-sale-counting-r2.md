# Brief: sale counting, round 2 fixes

Start: `git apply --3way docs/handoff/sale-counting-round2-fixes.patch` (the previous agent's unfinished work; it was fixing a tie break and two tests). Read it, then finish everything below. Scope: src/analysis, src/engine/collector.ts, src/engine/rebuild.ts, src/detectors/types.ts (additive), tests/unit, tests/sim, docs/verification.md. No migrations.

Findings from independent test round 2 (details and the tester's scripts: scratchpad testB2/report.txt, windows.mts, placebo.py):
1. **Equipment pull term double counts.** The equipment middle already leaves pulls out, and missed buys offset them. Simulator: equipment low is 13% of truth at 6 hours. Drop the pull term on equipment. On commodities, expected fake events = pull rate × chance of no real sale that hour.
2. **The commodity low is a fixed haircut.** sold_events is 0 or 1 per hour, so low/middle is poissonLower(n)/n whatever the volume (0.414 at 6 hours). New rule: low = max(0, mean − t·sd/√n) × 24 over all n watched hours of hourly units, zero hours included (one sided 95% t), with the Poisson rule as the floor for thin items. Tests must cover usefulness: at 6 and 24 hours, on deep and equipment markets, the low is under truth in at least 90% of windows AND above a stated share of truth set from the simulator.
3. **Expose Demand.hourlyMean, hourlySd, hourlyHours** (mean and sd of hourly sold units, and hours). The flip engine already reads these exact names.
4. **Dominant front reposter.** Add the scenario to tests/sim: 5 stacks of 20 at the floor, pulled and reposted hourly, 3 real buyers an hour. The middle reads 11 to 14 times truth. Add a per item flag `frontReplacedHourly` and cap that item's low at the Poisson floor of its partial buys, or null, with a note.
5. **netPerDay pulls:** rate × sold units / (1 − rate), from the previous row.
6. **Small fixes:** the equipment band SQL must not read the 12 point ladder; make the tie in the thin undercut scan deterministic; seeds 301 to 312 in the test as an out of sample check.

Finish: npm test and npx tsc clean. Commit early on your branch, do not push. Put the simulator usefulness table (low/truth and coverage at 6, 24 and 72 hours per market) and the real low/middle for Copper Ore, Linen Cloth, Light Leather and Frilled Lichen in `docs/handoff/findings-sale-counting-r2-fixes.md`. Report in at most 300 words.
