# Brief: flip core, round 6 fixes (from independent test round 3)

Scope: src/flips, src/rules/flips.ts, tests/unit/flips*, docs/flip-plan.md section 6 if numbers change, docs/verification.md (rows F26 and on). The tester's scripts and outputs are in scratchpad testC3/ (r3.py, recomp3.py, diag6.mts, trace.py).

1. **HIGH: expected sales use the middle estimate.** That is evaluate.ts:165-166 with sellBook.ts:127-129. As a result, 2 sale events from one seller repricing become 505g (Timbermaw Brawlers), and reposts across a gap become Clam Linguine's 60g. Plan section 6 says the inputs are cautious. Tonight's and tomorrow's queue means must use the low estimate (Demand.lowPerDay, which is now the hourly t bound with a Poisson floor), not the middle. Keep the middle only as the card's "about N" figure. Rerun the diagnostic and confirm Timbermaw and Clam Linguine collapse or are held back.
2. **HIGH: teaching items with no source** (run.ts:235). When the only learn source is a teaching item with no vendor, loot or auction record, the card says "how to learn it is not known yet (the recipe item has no known source)", and that is a risk driver. Felblood Soul Bag, real #1, is the case: a bind on pickup epic pattern.
3. **MEDIUM: cooldown crafts during learning** (run.ts:115-125). A cooldown recipe's vendor path is held back with "the auction house likely pays more; waiting for sales data" when its product has listings whose cheapest is over twice the vendor price. Example: Refined Deeprock Salt at 10s vendor while 170 listings sit at 38g.
4. **LOW:**
   - evaluate.ts:173: `cut > 0` skips the vendor margin check when the first step fails it.
   - evaluate.ts:239: the small row ignores the craft session, so it can be larger than the most row.
   - Tomorrow's bad case assumes the units ahead clear at the expected rate. Use the bad case rate.
   - Do not charge a second deposit while a 24 hour listing is still up overnight.
   - Add a verification row for the normal overnight model, which is unreachable on live data until 6 hours exist.

Finish: npm test and tsc clean. Commit early on your branch, do not push. Put the diagnostic before and after in `scratchpad/findings-flip-r6.txt`. Report in at most 300 words.
