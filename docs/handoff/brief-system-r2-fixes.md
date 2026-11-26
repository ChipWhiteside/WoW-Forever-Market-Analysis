# Brief: fixes from whole system review round 2

Detail: scratchpad findings-system-r2.txt. Backtest tools: sys2/bt.mts, bt.json and bt-analysis.txt. Reuse them to prove each fix.

## Agent F (src/flips, src/rules/flips.ts, web/src/pages/flips.tsx, tests)
1. **HIGH: competition window.** newPosts.ts:56 reads new posts over 24 hours while sales use 72. Use the same window and the same differenced pairs as sales. If competition has fewer than 6 watched hours, do not assume zero: hold the auction flip back as learning ("competition not measured yet").
2. **HIGH: slow undercutters are invisible.** newPosts.ts:22-26 counts only posts at or under today's post price. Count new posts at or under 1.05 times the post price as competition. Measure floor drift over the watched hours (a regression slope). When the floor is falling, lower the claim by the drift over the horizon, and fire price war on a cumulative fall of 10% or more across the window, not only within one hour. Prove with the backtest that Hot Spices no longer claims a profit it does not realise, and that medium risk flips still realise at least their claim.
3. **MEDIUM: thin evidence.** An auction flip needs at least 3 sale events in the window. Timbermaw Brawlers rests on 2 listings that vanished together.
4. **MEDIUM: unknown learn source.** These crafts rank after every flip whose learning is known. The sort key is (learnable known first, then expected profit). The card says "ranked lower: how to learn it is not known yet". Requirements Chip can train never lower a flip; only unknown ones do.
5. **MEDIUM: phone cards.**
   - When there are more than 3 Buy or Make first lines, show the first 3 and a "show N more" toggle. Nothing is removed; this is the additive rule.
   - Put Make first steps before the Make line.
   - Reduce the left padding on phones so the text column is wider.
   - Use `break-words` rather than mid word breaks.
6. **LOW:**
   - flips.tsx:168 says "1 units".
   - run.ts:326 shows "(B21)" to Chip: remove ledger codes from card text.
   - The stale page should say the data is old, not that nothing cleared the checks.

## Agent S (src/analysis, tests/sim, docs/verification.md)
7. **HIGH: cancel and repost at a new price reads as sales on deep commodities** (Clam Linguine: 116 sold from a 440 unit reprice). Find a signal that separates a repost from buys on deep commodities without erasing real sales. Candidates:
   - new listing ids for the item that are contiguous or posted together, totaling the vanished units within 25%, at a lower price, in the same hour;
   - the vanished stacks being the newest at their price.
   
   Validate with the simulator, adding a deep market repricer scenario, and with real snapshots: Clam Linguine and the B35 placebo comparison. If no signal holds, say so and lower the low estimate's confidence on items where a same hour repost of matching total units occurred.

Each agent: npm test and tsc clean. Commit early on your branch, do not push. Put detail in scratchpad/findings-system-r2-fix-<F or S>.txt. Report in at most 300 words.
