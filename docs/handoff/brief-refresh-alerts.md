# Brief: refresh button and best of the best Discord alerts (Chip, November 26)

## Chip's decisions
1. **Hourly job.** It collects each publish and counts sales, as today. It runs the flip analysis quietly, for alerts and trends only.
2. **Refresh button on the Flips page.** It pulls the newest publish for Chip's houses now (a 304 if nothing is new), counts sales, runs the full flip analysis and shows the result. While it works it says "Checking Blizzard..." with a spinner, then shows the data time, for example "Data from 12 min ago; Blizzard publishes about 25 past each hour, next one about 13:25".
3. **Discord alerts only for the best.**
   - Bars: **Good** at 10g or more expected overnight, **Amazing** at 20g or more. Store them as settings `alert_good_gold` (default 10) and `alert_amazing_gold` (default 20), editable in Settings below the existing fields.
   - A flip alerts only when all of these hold:
     - expected profit at or above the Good bar;
     - risk low or medium;
     - strength 75 or more;
     - 6 or more hours of watched sales when it sells on a house;
     - a known learn source;
     - not held back for any reason;
     - the run is complete and fresh.
   - **No cap per hour.** Every flip that qualifies in the same run is sent. One message per run, one line block per flip, Amazing first. Split into several messages if Discord's 2,000 character limit requires it.
   - **Repeats.** The same flip key is not re-sent within 24 hours unless its expected profit grew by 25% or more since its last alert.
   - Quiet hours follow the existing settings. Alerts held during quiet hours are sent at the end of the quiet period, if still live.
   - Each block: tier, item, Crafting or Flipping, expected overnight, profit per item, best amount, risk, strength, buy and sell in one line each, and a link to the app (appUrl).
4. **Old play alerts** (src/alerts/discord.ts alertCycle for the old detectors) go off by default. Add a setting `play_alerts` (default off) that turns them back on; the Settings page gets a checkbox below the existing fields. This is a protected path, approved by Chip ("full autonomy").
5. **Log every alert** so the bar can be tuned: migration 14 adds a table `flip_alerts` (key, at, tier, expected_profit, per_item, units, data_at). Add a CLI report, `npx tsx scripts/alert-review.ts`, that lists recent alerts and, for each, whether the flip was still live at the next publishes and whether the product sold near the claim. Use the existing backtest logic where it fits.

## Scope
src/flips (an alerts module, plus a refresh entry point reusing hourlyFlips), src/alerts, src/server (a POST /api/flips/refresh route that runs collector polls for Chip's houses through the engine; when engine is null, return 503 with a plain reason), src/engine/engine.ts (wiring), src/store/db.ts (migration 14 only), web/src/pages/flips.tsx (the button, added at the top beside the run status, nothing removed), web/src/pages/misc.tsx (settings), docs/page-contracts.md and its test (add the button), docs/verification.md rows, docs/flip-plan.md (section 0, add these decisions), and tests.

## Tests
- Alert gates: a flip at 25g low risk alerts Amazing; 12g Good; 9g none; 25g high risk none; learning none; unknown learn source none; held back none.
- Two qualifying flips in one run: both sent, in one message.
- A repeat within 24 hours is suppressed; one grown by 25% is sent.
- Quiet hours hold an alert, then send it.
- The message stays under 2,000 characters per post, splitting when needed.
- The refresh route: with a new publish it ingests and reruns; with a 304 it reruns on stored data and says so; when the engine is busy with a round it waits or answers 409.
- The page contract test covers the button.

Finish: npm test, tsc for server and web, and npm run build:web all clean. Screenshot the Flips page with the button at 390 and 1440 px. Commit early on your branch, do not push. Put detail in scratchpad/findings-refresh-alerts-build.txt. Report in at most 300 words.
