# Brief: sale counting, round 3 fixes (from independent test round 3)

Scope: src/analysis, tests/unit, tests/sim, docs/verification.md. The tester's detail and scripts are in scratchpad testB3/ (findings.txt and the churn scripts beside it).

1. **HIGH: the reposter flag can never fire in production** (history.ts:186-188 and :228). The LAG CTE filters `published_at >= since`, so the window's first row has `prev_floor` NULL, but the flag needs `replaced >= n`. Run the reposter scenario for 96 hours: the flag was off at 72, 73 and 96 hours, and the low read 2,114 a day against about 203 true. Compute the lag over rows from before the window too. Extend reposter.test.ts to 96 hours.
2. **MEDIUM: the flag needs every hour.** One skipped hour in 24 clears it, and the low then reads 1,938 against 278. Fire it when the front was replaced in at least 80% of the window's hours.
3. **MEDIUM: repost churn reads as sales with zero buyers** (aggregate.ts:346 and :373). At 6 hours the low reads:
   - a floor seller repricing a deep equipment market (more than 5 copies): 48;
   - a reprice of more than 25%: 48;
   - a repost across a publish: 5.5 on equipment, 69 on a thin commodity;
   - a thin commodity reposted in different stack sizes: 679.
   
   Treat these as reposts when the same hour brings new listings for the item that replace the vanished units: total units within 25%, any stack sizes, any price below the old one, and on equipment, a new cheaper copy. That applies only to thin markets and to equipment, never to deep commodities (B35 showed no signal there). Prove with the simulator that real sales on thin and equipment markets are not erased: coverage and the usefulness shares must hold. Timbermaw's pattern (2 listings repriced) must give a low near 0.
4. **LOW:** in tests/sim evaluate, count windows where the truth is 0 (a low above 0 there is a false sale). Commit B42's cited findings as `scratchpad/findings-sale-counting-r2-fixes.txt`, or fix the citation in B42.

Finish: npm test and tsc clean. Commit early on your branch, do not push. Put the before and after for each churn shape and the simulator usefulness table in `scratchpad/findings-sale-counting-r3-fixes.txt`. Report in at most 300 words.
