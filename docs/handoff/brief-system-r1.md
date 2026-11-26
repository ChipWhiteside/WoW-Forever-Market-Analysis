# Brief: whole system round 1

The live collector in this cloud session only ever captures pairs of publishes, because worker restarts kill it. Auction flips can never pass the 6 hour learning gate on live data here. So the end to end checks use recorded snapshots, with prices injected and hours of history synthesized from real snapshots.

## Agent A: end to end yardstick suite (builds tests)
Build `tests/e2e/goldens.test.ts` (vitest), plus small fixtures cut from the real raw snapshots in the scratchpad (live/raw, or salework3/raw). Use about 150 real background items plus the yardstick items, and 8 or more hourly snapshots built from real ones by shifting time and injecting buys. Keep fixtures under 2 MB in total.

The suite runs the whole pipeline with nothing stubbed: collector aggregate, then rebuild, then demandByItem, then hourlyFlips, then /api/flips through buildServer().inject().

It must assert:
1. **Cerulean Dye at Ben's prices** (2 Frilled Lichen at 25 to 30s with depth, Empty Vial from a vendor at 20c per 5, dye selling 70 to 80s with real hourly sales) lands in the top 10 as a green craft, at medium or low risk.
2. **Bright Baubles** (vendor Old Man Heming at 250c, a Blackwater house pinned, selling near 5s, 15% cut) shows or is held back purely according to its stated sales, and the reason is asserted.
3. **Today's prices:** both are held back with a plain reason.
4. **Near misses:**
   - Lichen at 36s: gone.
   - Dye selling 1 a day: weak or gone.
   - One troll dye listing at 5g: price unchanged.
   - A three listing troll: price unchanged.
5. **Junk stays out:** Lionheart Helm on 3 listings, a transmute past its cooldown, a bind on pickup product, a random yield product.
6. **Run report:** complete, and incomplete when the data is stale.

## Agent B: whole system review (read only)
1. **Engine:** start it on a copy of scratchpad/live, run `--once`, and check it ends with a flips line and a flip_runs row.
2. **Flips page:**
   - Build the app (`npm run build:web`) and serve the copy with `npx tsx src/engine/main.ts` (PORT 4343, DATA_DIR set to the copy). Skip the engine round by using the server only if that is possible; read src/server.
   - Take Playwright screenshots at desktop and phone width.
   - Check every element in docs/page-contracts.md for the Flips page is present and readable.
   - Check the green and blue cards, the risk chips, the amounts table and the held back list.
3. **Additive rule:** compare the Now, Crafting and Profit board pages with their contracts, and confirm nothing is missing.
4. **Recompute:** recompute the top 15 real flips (vendor sales) and 10 diagnostic auction flips in your own code. The round 3 tester's scripts are in scratchpad testC3/.

Write findings to scratchpad/findings-system-r1-<A or B>.txt. Report in at most 300 words.
