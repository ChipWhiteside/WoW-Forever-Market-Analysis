# Brief: refresh and alerts, round 1 fixes

Detail is in scratchpad raT1/findings.txt, and the tester's scripts are beside it. Scope: src/engine, src/flips, src/server, web/src/pages/flips.tsx, tests, docs/verification.md.

1. **HIGH: double alerts.**
   - The startup detect (main.ts:34) and the detect in /api/houses/pin (server.ts:47) run outside the engine's busy lock. A refresh landing then sends every alert twice: 15 sent twice, 30 rows.
   - Fix both:
     - Every detect path takes the same lock the rounds and the refresh use.
     - In alerts.ts, claim before sending: write the flip_alerts row (status pending) in the same transaction as the repeat check, send, then mark it sent or failed. A failed send is retried next run.
   - Test it with two overlapping runs and a slow mocked Discord.
2. **MEDIUM: a refresh with nothing new erases "new this hour".** Each rerun writes flip_history (read in run.ts:237 and inputs.ts:258). Key the history by publish (data_at), not by run time: a rerun on the same data updates the row for that data hour rather than adding one. Make "new this hour", openHours72 and the backtest read it by data hour. Test that a 304 refresh keeps "new this hour".
3. **MEDIUM: alert-review counts reruns** (alertReview.ts:26). Use the next distinct publishes (data_at) after each alert, print item names rather than keys, and say plainly when too few publishes exist yet.
4. **LOW: a failed poll reads as "Nothing new (304)"** (engine.ts:237, server/flips.ts:32). Return the errors, and have the page show them ("Blizzard did not answer for house 111: …"). Rerun on stored data only if at least one house answered.

Finish: npm test, tsc for server and web, and build:web clean. Rerun the tester's double send repro and confirm it now sends once. Commit early on your branch, do not push. Report in at most 250 words.
