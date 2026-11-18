# Build status, November 18, 2026

## Done and tested (49 tests, typecheck clean, clean clone installs and builds)
- Chunks 0 to 14 of `docs/build-plan.md`: engine, collector for all 8 candidate houses, data contracts, item catalog, EG Link vendors, loot and names, recipes with wago thresholds, fees, detectors O1 vendor dump, O2 vendor supply, O3 underpriced, O6 sell now, O7 cross house, play lifecycle, Discord alerts, health, daily jobs (dataset refresh, vendor price news, rollups, backups), calibration report, every app section, House finder, setup with auto start, overnight loop with guards, watchdog and replay.
- Independent review found 10 issues in the money logic. All fixed with tests.
- Live checks that passed: EG Link (T4 vendor faction, loot, names), wago thresholds (T3 bar), overnight loop drills.

## Blocked
- **Live Blizzard verification (chunk 15 and P1, P2 in `docs/verification.md`).** The cloud credential is rejected. On Chip's PC, `npm run setup` proves the credentials before anything else, and `npm run contract` checks every live shape.

## Deliberately not built yet
- O9 quest demand tag and the disenchant detector (phase 2 per the plan).
- Character data from the profile API (T8). Professions are typed in Settings for now.
- Companion addon (R7) and the website version (R8).

## Next, in order
1. Fix the oauth.battle.net network secret (or restart the session so the env vars load), then the live end to end run: real publishes on all candidate houses, hand check O1, O2 and O7 numbers against real rows.
2. Chip installs on his PC and picks his houses.
3. First two nights of the overnight loop, then tune caps from the changelog.
