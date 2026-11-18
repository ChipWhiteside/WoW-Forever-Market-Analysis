# WoW Forever Gold Finder: The Build Plan

Version 4 of the plan, November 18, 2026. Builds on `wow-forever-gold-finder-spec.md` (v3), the verification ledger and the API runbook. Where this plan and v3 disagree, this plan wins, and the v3 deltas are listed in section 4.

## 1. Context

Chip wants a money radar for WoW Forever. The market is two weeks old and chaotic, mispricings open and close within hours, and Bright Baubles proved that being the one person who sees the gap is the whole edge. Today that edge is luck. The goal is to make it a system.

What Chip actually asked for, decoded from the words:

1. **A background engine, a foreground glance.** Gathering, logging, analysis and history all happen without him. He never updates a log by hand.
2. **A ping when a window opens, before it closes.** On his phone, only when there is something worth his time.
3. **Every gold method in one organized place,** ranked, explained in one sentence, with how to act on it. He decides quantity in the moment.
4. **It gets better on its own.** Code that calibrates itself from its own history, plus an overnight agent loop that audits, fixes, tests, reviews and ships, with a changelog for the morning and a revert when it goes wrong.
5. **Desktop now, his website later** so his brothers can use it.

Three honest constraints shape everything below.

1. **The timing ceiling is hourly.** Blizzard publishes each house about once an hour (ledger V17). The tool cannot beat that. It wins by reading every one of roughly 7,000 items within a few minutes of each publish, which no human does.
2. **History is the moat and its clock starts at first run.** Blizzard only serves the current snapshot. Every hour not captured is gone forever. So the collector ships first, today, and everything else stacks on top of it.
3. **The scope is big.** Naming it, Chip: the full v3 spec is eight releases. "Over the next couple of days" gets the engine, the money detectors that need no history, alerts and the app. Crafting and world drops follow within the week. The addon and the website are later on purpose. The order below is by gold per hour of build time, so if anything runs short, what exists is already the most valuable part.

## 2. Verified today from this session

1. This cloud container reaches `oauth.battle.net`, `us.api.blizzard.com`, GitHub raw, `wago.tools`, Discord and the item icon CDN. So I can build and test against live Forever data here, unlike the earlier chat sandbox.
2. The EG Link dataset is `github.com/JIVESCORP/eg-link-output-wowf`, CC BY 4.0, updated today. It holds far more than v3 assumed: `vendors`, `trainers` (recipe learn ranks and costs), `loot` (drop chances with kill totals), `creatures` (levels, classification and **reactions**, which solves the vendor faction join, test T4), `flights` (route times), `quests` (quest items, a demand signal), `item_hotfixes` (names the client lacks, which attacks the unnamed item problem, test T2), and `game_rules`. One source covers most of the gap list.
3. `wago.tools` lists the `wow_classic_beta` product. Its `SkillLineAbility` table carries yellow, green and grey thresholds per recipe. The exact Forever build folder gets confirmed in chunk 4, under the ledger rule.

## 3. Architecture

Code computes. Agents judge. Chip decides.

```
Chip's PC (always on while he wants alerts)
 ├─ Engine (one Node process, auto starts at login and wake)
 │   ├─ Poller: every 2 min per house, If-Modified-Since, 304s are free
 │   ├─ Ingest: parse, validate against data contracts, store
 │   ├─ Analyze: floors, ladders, sell through, typical floor
 │   ├─ Detect: O1 to O9, pure functions, net of cut and deposit
 │   ├─ Alert: one Discord message per publish cycle, only if new plays clear the bar
 │   ├─ Health: assertions after every run, written as run reports
 │   └─ Daily jobs: dataset refresh, vendor price refresh, rollups, backup, calibration
 ├─ App: local web app on http://localhost:4242, installable as a desktop app window
 └─ Overnight loop: Claude desktop scheduled task, 1am to 5am, agents in .claude/agents
Phone: Discord app receives alerts and the morning changelog digest
```

### 3.1 Stack, chosen for zero friction on a Windows PC and a clean path to the website

| Piece | Choice | Why |
| --- | --- | --- |
| Language | TypeScript on Node 22.13+ | Chip's daily language, cross platform, same as the existing probe scripts |
| Storage | SQLite through built in `node:sqlite` | One file, no native build step on Windows, behind a thin store module so Postgres or Supabase can replace it for the website |
| Raw snapshots | gzipped JSON on disk, 14 days | Lets detectors be replayed after a bug fix, which the overnight tester needs |
| Validation | zod data contracts on every external payload | The ledger rule as code: never infer a shape from a name |
| API server | Fastify | Small, fast, serves the app and JSON |
| App | Vite, React, TanStack Query, Tailwind, shadcn/ui, uPlot for charts | Chip's known toolset. A static build the engine serves, so the website later is the same app pointed at a hosted API |
| Tests | Vitest, recorded real fixtures, replay harness, Playwright smoke | Chromium is preinstalled here |
| Alerts | Discord webhook | Free, already on his phone, scales to a channel per brother |
| Service | `npm run setup` registers a Windows Task Scheduler entry (launchd on Mac) that starts the engine at login and restarts it on crash | No terminal to keep open |

### 3.2 Where data lives

1. **Code** in the repo. **Data never in the repo.** `DATA_DIR` defaults to `~/.wowf-gold-finder/`, outside the project, so agent worktrees, reverts and git operations can never touch history.
2. Inside `DATA_DIR`: `wowf.db` (SQLite), `raw/` (14 days gzipped), `datasets/` (EG Link and wago copies with versions), `reports/` (run and health reports the overnight auditor reads), `backups/` (7 nightly copies of the database).
3. **Retention.** Per item per snapshot aggregates (floor, units at floor, units within 5 percent, total units, listings, ladder buckets, disappeared units split by time left) kept hourly for 90 days, then rolled into daily rows kept forever. Candidate houses not chosen by Chip drop to 72 hours once he pins his two. This deviates from v3 "every hourly row forever" to keep the database fast. Reversible.
4. **Secrets** only in `.env` on the PC, ignored by git: Blizzard client id and secret, Discord webhook URL.

### 3.3 Folder structure

```
docs/            spec v4, plan, ledger, runbook, data contracts, CHANGELOG.md
src/blizzard/    token cache, client with retry and backoff, endpoint contracts
src/datasets/    eglink, wago, sync with versions and attribution
src/store/       schema, migrations, repositories
src/engine/      poller, publish tracker, ingest, scheduler, daily jobs
src/analysis/    floors, ladder, sell through, typical floor, history windows
src/rules/       PROTECTED. Cuts, deposit, profit math, thresholds
src/detectors/   one file per play type, pure functions
src/alerts/      discord, dedupe, quiet hours
src/health/      assertions, run reports, suspected bug flags
src/server/      Fastify API
web/             the app
.claude/agents/  auditor, architect, implementer, tester, reviewer
.claude/commands/nightly.md   the master
scripts/         setup, service install, replay, contract check, house finder
tests/           unit, fixtures from real payloads, replay goldens, e2e
```

Chip's uploaded files stay exactly where he put them as the historical record. New living docs (spec v4, ledger updates, changelog) go in `docs/`, and the README points to both.

## 4. Product refinements over spec v3

Everything in v3 stands except these.

1. **Faster than "within 5 minutes".** Poll every 2 minutes with If-Modified-Since rather than every 15. Each house publishes at its own minute, and the engine learns that minute and tightens polling around it. Target: plays in the app within 3 minutes, alert within 4.
2. **No house pinning blocker.** The engine collects all eight live candidate houses (Alliance 110, 111, 119, 123 and Blackwater 116, 117, 121, 125) from minute one. A **House finder** screen shows Copper Ore and Linen Cloth floors per candidate. Chip clicks the two matching what he sees in game. History is already there for whichever he picks.
3. **Play lifecycle, built for "before they fade".** Every play is New, Live (with how many snapshots it has survived), Fading (profit shrank since last snapshot) or Gone. Over time the engine measures each detector's real half life on his houses and shows "plays like this usually last about 2 hours". That number gets better with every week of history.
4. **O9, a new play type from the YouTube research: quest and farm demand.** Items players need for quests (EG Link quests and item uses) whose floor sits far above vendor value and which drop from known creatures. Shows up inside World drops as a "people buy this to skip farming" tag, the Giant Eggs and charm pattern.
5. **Containers count as sources.** Trunks and chests from fishing appear in World drops by source with value per open from EG Link loot, which turns Chip's trunk fishing into a measured number.
6. **Disenchant value** is listed as a phase 2 detector, shown in Item lookup only once ItemDisenchantLoot data is verified. Not built in the first days.
7. **Market section adds trend insight,** the "cheapest it will ever be" pattern from the videos: seven day floor slope against units trend, flagged as insight and never alerted.
8. **Calibration report, daily, no Claude.** Per detector: plays found, median life, share that closed by price moving versus listings vanishing, and how Chip's done plays actually paid. Threshold changes stay protected, so the loop proposes them and Chip approves.
9. **Faction join through EG Link creature reactions,** replacing the fragile Waypoint and AllTheThings match.
10. **Names: Blizzard item data first, then EG Link item hotfixes, then wago, then the id.** Never dropped.

## 5. How the app looks and feels

1. **Light, warm and clean.** Off white parchment base, deep ink text, one gold accent, generous spacing. Follows system dark mode for late night only if Chip turns it on.
2. **The WoW layer is a light touch.** Cinzel for section headers only, Inter with tabular numbers for everything else. Real item icons. Gold, silver and copper coin glyphs on every price. Item quality shown as a colored rim on the icon and a small pill, since quality colors fail contrast as text on a light background. House badges, Alliance blue and Blackwater green.
3. **Left rail section manager:** Now, Vendor plays, Resale, Crafting, World drops, Farming, Positions, Watchlist, Market, Item lookup, Changelog, Health, Settings. Search anything from any screen with Ctrl K.
4. **A play card reads in three seconds.** Profit available leads, big. One sentence says what and where. Then data age, confidence, house, lifecycle state, trip time. Click opens the play view: ladder, a week of floor history, vendor or source details, Done, Skip and Already gone buttons.
5. **Health strip at the top of Now.** Green when every house published on time, amber with the gap named when one is late or the PC was off, plus "plays from stale data are hidden".
6. **Every screen under 2 seconds.** Checked by the Playwright smoke test against a seeded database.

## 6. How I build it, chunk by chunk

Every chunk runs the same loop, at least three passes and up to five: build, run its tests, check against live data, review the diff with fresh eyes, fix. A chunk is done only when its "done when" line passes. Larger chunks get one fresh context reviewer subagent at the end (cheaper model for routine chunks, the strongest for rules, detectors and the overnight loop). Order is by value, so the history clock starts first.

| # | Chunk | Done when |
| --- | --- | --- |
| 0 | Foundation: repo layout, TypeScript, lint, Vitest, config, `.env` loading, docs moved, ledger rule written into `CLAUDE.md` | `npm test` and `npm run typecheck` pass clean, `.env` provably ignored |
| 1 | Blizzard client: token cache, retry with backoff on 429, If-Modified-Since, zod contracts for house, commodities, item, media, profession, recipe | Live contract check passes on all endpoints. One real record of each saved as a fixture. Zero row responses raise a suspected bug flag, tested with a fake empty house |
| 2 | Collector and storage: poller for 8 houses, publish tracking, raw gzip, aggregates, ladder buckets, listing id diff with time left split | Runs here for 3 or more real publishes per house with zero missed. Copper Ore and Linen Cloth floors match the ledger's method. Strict id set diff, never counts |
| 3 | Item catalog: names, quality, class, binding, sell and purchase price, stack, icons, layered name fallback, cached forever with a daily refresh of sell prices | At least 95 percent of distinct ids on the candidate houses named, rate recorded (T2). Binding present and correct on five known items (T1). Icons resolve for a Forever only item (T11) |
| 4 | Datasets: EG Link vendors, trainers, loot, creatures, flights, quests, item hotfixes, plus wago skill thresholds and Blizzard recipes walked for all professions | Bright Baubles resolves to Alliance usable sellers only, Nerrist excluded (T4). Rough Sharpening Stone reads 15, 35, 55. Unmatched recipes listed, never dropped (T3). Flight time Stormwind to Booty Bay present (T15) |
| 5 | Rules and analysis: cuts 5 and 15 percent, deposit assumption (decision 4 in v3) behind one switch, floor, typical floor, sell through, history windows that stretch after a gap | Hand calculated cases pass, including the roughly 17.6 percent Blackwater break even |
| 6 | Detectors with no history needed: O1 vendor dump, O2 vendor supply, O7 cross house flip, with lifecycle and ranking | Replay on real stored snapshots produces plays whose numbers match a hand calculation. A fake listing under vendor price is caught. Nothing ever shows a Horde vendor |
| 7 | Alerts: Discord message per publish cycle, dedupe, 25 percent growth rule, quiet hours, morning digest | A fake publish with new plays sends one message, a publish with nothing sends nothing, a repeat sends nothing |
| 8 | Server and app shell: API, Now, Vendor plays, Resale, Item lookup, House finder, Health, Settings | Playwright opens every section under 2 seconds with screenshots I review for glanceability |
| 9 | O4 crafting make or buy tree, intermediates, skill point view, everyone view | Copper Bar shows three paths with the cheapest matching a hand calculation. A blocked ingredient shows "no source". No bind on pickup product is ever a sale |
| 10 | O8 world drops by item and by source, containers, O9 quest demand tag | Every rate shows its kill count and origin. Value per kill for one creature matches a hand calculation |
| 11 | History detectors coded with cold start: O3 underpriced, O6 sell now, Market section, calibration report | Each shows "learning, N of 24 hours" correctly, then fires on a seeded history test |
| 12 | Positions, watchlist, farming timer, character data from the profile API (T8) | Done on a play opens a position and available gold drops. 20 Copper Ore in 10 minutes reads 120 an hour |
| 13 | Setup and service: `npm run setup` prompts for secrets, installs, registers auto start, opens the app | Fresh clone to running engine in one command, tested in a clean folder here |
| 14 | Overnight loop: agent files, master command, window guard, protected path guard, replay goldens, auto revert watchdog, changelog writer | A planted bug is found, fixed, tested, reviewed, merged and logged. A planted unfixable bug reverts after three rounds and is flagged. A run at 10am exits doing nothing |
| 15 | End to end: the full engine runs here for several hours on live data, then a final whole system review by a fresh reviewer, then fixes | Every "done when" above still passes together. Docs, changelog and Chip's setup steps are final |

Chunks 0 to 8 are the "next couple of days" target and already make money. Chunks 9 to 15 follow in priority order. Everything is committed and pushed to `claude/loving-keller-okyqnz` at the end of each chunk, so nothing is lost if the container resets.

## 7. The overnight improvement loop

Agreed with Chip in the earlier conversation, made concrete.

1. **Where.** A Claude desktop scheduled task on his PC at 1am, running `/nightly`. It sees the local run reports and history. A run that starts outside 1am to 5am exits immediately, which stops daytime catch up runs.
2. **Roles,** each a file in `.claude/agents/` with its own tools and turn limit. Master (the command) picks work and enforces caps. Auditor is read only and files issues with evidence from run reports and a fresh pull. Architect plans anything bigger than one file. Implementer works in a git worktree. Tester proves the fix with a test that failed before, runs the full suite, the live contract check and the replay goldens. Reviewer checks the diff is minimal, clean and touches nothing it should not.
3. **Going live.** Both tester and reviewer pass, the master merges to the branch the engine runs from, the engine restarts on the new commit, and a watchdog script (plain code, no Claude) reverts automatically if any health check that passed before now fails.
4. **Stop rules.** One change in flight at a time, at most three rounds, a worse round or a third failure reverts and marks "needs Chip".
5. **Protected, never auto merged:** `src/rules/`, schema migrations that delete data, alert, budget and schedule settings, new data sources or credentials. These become proposals in the changelog. Enforced by a guard script, not by trust.
6. **Budget.** Two issues a night, three rounds each, per agent turn caps, a cheaper model for the auditor and reviewer. Usage credits off on Chip's plan so the ceiling is hard. The changelog records turns and time per night. Tuned after two nights.
7. **Morning.** One Discord message summarizing what went live, what reverted and what needs him, with the full entry in the Changelog section.

## 8. What runs when, now and later

| Rhythm | What | Claude used |
| --- | --- | --- |
| Every 2 min | Poll all houses, 304 when unchanged | No |
| Each publish | Ingest, analyze, detect, alert, health check | No |
| Daily 4am | Refresh datasets and vendor sell prices, flag changes as news, roll up old rows, back up the database, calibration report | No |
| Nightly 1am to 5am | Overnight improvement loop | Yes, capped |
| Weekly Sunday | Market report generated, data growth summary | No |
| Morning | Discord digest of the night | No |

**Today to day 3.** I build chunks 0 to 8, testing against live data from this container. Chip installs once, enters secrets, picks houses, and the engine starts its history. O1, O2 and O7 alert from the first hour.

**Week 1.** After 24 hourly readings the typical floor exists and O3 starts firing. Sell through estimates begin. Crafting and world drops land. The overnight loop runs its first two nights and its caps get tuned.

**Week 2.** Seven days of history unlock Market movers, week over week change and trend insight. The calibration report has enough plays to show each detector's real half life and hit rate, and the loop starts proposing threshold changes for Chip to approve. Raid prep for December 9: the crafting board watches flasks, potions and resist gear.

**Month 1.** Hour of day and weekday patterns show when floors dip, so "best hour to buy Wool Cloth" becomes a fact. Hourly rows older than 90 days begin rolling up. Phase 2 detectors (disenchant value, consumable demand) come online. Decision point on the companion addon and on moving the engine to an always on host.

**When the PC is off, history is lost.** Accepted for now at zero cost. The trigger to move to a small always on host (about five dollars a month) or Chip's website host is either a week with more than 10 percent of hours missed, or the brothers joining. The engine is built so that move is a deployment, not a rewrite.

## 9. What I need from Chip

Ordered by effort, smallest first. None of it blocks me from starting.

1. **Blizzard secret, one minute.** When I start building, a secure form appears in this session. Paste the client secret there, never in chat. It lets me test against live data here.
2. **Discord webhook, three minutes.** Make a private server, a channel, and a webhook under its settings. Paste the URL into the app's setup on the PC.
3. **Install, ten minutes,** once I finish: pull the branch, run `npm run setup`, which asks for the secret and webhook and starts everything.
4. **Pick houses, one minute,** in the House finder, matching Copper Ore and Linen Cloth to what he sees in game at Stormwind and Booty Bay.
5. **Character name** in Settings so professions and reputation come in automatically (T8).
6. **Overnight loop, five minutes:** create the Claude desktop scheduled task the setup guide shows, turn usage credits off, enable keep computer awake.
7. **Later, in game:** the listing rules test (T7) and Mister Graphed's prices (T13) when convenient.

Assumptions I am making instead of asking, each correctable in one line: his PC is Windows; Discord is the alert channel; the engine runs from my branch until he merges it to main; the app is a local web app installable as a desktop window rather than an Electron build.

## 10. Verification, end to end

1. `npm test` (unit, fixtures, replay goldens) and `npm run typecheck` clean.
2. `npm run contract` against live Blizzard and the datasets passes, and every suspected bug flag is explained.
3. The engine runs here for several hours across real publishes on all candidate houses with zero missed snapshots, and plays appear within 3 minutes of each publish.
4. Hand calculated checks for O1, O2, O7, Copper Bar make or buy, and one value per kill, recorded in `docs/verification.md`.
5. Playwright screenshots of every section under 2 seconds.
6. The overnight loop's planted bug and planted unfixable bug tests both behave.
7. A clean folder install with `npm run setup` reaches a running app.
8. The verification ledger gains a row for every new fact proven, dated, and every unproven belief stays in the unverified table.
