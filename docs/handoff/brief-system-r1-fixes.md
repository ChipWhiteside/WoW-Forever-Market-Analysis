# Brief: fixes from whole system review round 1

Details and screenshots are in scratchpad findings-system-r1-B.txt and sysB1/. Scope: web/src/pages/flips.tsx, src/flips/*, src/rules/flips.ts, tests. The additive rule holds: fix wording and layout, never remove agreed content. Keep tests/unit/page-contracts.test.ts passing.

1. **Phone width (390 px).**
   - The open amounts table overflows its card and the page scrolls sideways (584 px wide). Wrap the table in a horizontal scroller inside the card.
   - Item names truncate to a few letters ("Felblo..."). Let names wrap on narrow screens.
   - The Now page widens on long names; fix that the same way, layout only.
2. **Card text bugs.**
   - "Needs Tailoring 300 at how to learn it is not known yet": when the setup is unknown, do not prefix "at".
   - "about under a day to sell": say "under a day to sell".
   - "1 units": use the right plural.
   - The Buy lines list craft steps, including the product itself. Buy lines show only what is bought (auction or vendor). Show craft steps on the Make line, and never the product as its own input.
3. **A cooldown sub craft is valued at what its product would sell for.** Cured Rugged Hide spends the Salt Shaker cooldown (Refined Deeprock Salt) to earn 1s 47c, while the salt sells for about 37g on the auction house. In the cost book, a sub craft on a cooldown costs at least the product's own cautious auction net when it is listed: the opportunity cost. Test it.
4. **Learnability risk.**
   - A teaching item with no known source makes the flip high risk (Felblood Soul Bag, real #1).
   - "Horde trainers only" (learn_source trainer_horde_only) becomes a risk driver: "no Alliance trainer on record; trainer lists usually match across factions (B21), check in game". It does not change the level.

Finish: npm test and tsc clean. Build the app (`npm run build:web`). Take Playwright screenshots of the Flips page at desktop and at 390 px from a copy of scratchpad/live, serving with startServer and engine null, as the reviewer did in sysB1/. Check them and confirm there is no sideways scroll. Commit early on your branch, do not push. Report in at most 300 words.
