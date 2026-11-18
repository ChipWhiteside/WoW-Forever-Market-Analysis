# WoW Forever: Money App Spec and Gap Analysis

Chip's vision, what the Blizzard API can actually serve, what it cannot, the gaps the original plan missed, and the build order by effort. Supersedes the DATA PIPELINE PLAN section of the market and money doc, which should be collapsed to a pointer at this doc next time that file is touched.

Credential setup lives in the API setup runbook. Read that first if the bot does not yet run.

## The vision as stated (November 16)

One app that connects to the Blizzard API, pulls item and price and location and quest and recipe data, refreshes auction prices on demand for Chip's market, then ranks every money making opportunity. Four opportunity types named. Auction house flipping, vendor to auction arbitrage, crafting from bought components, and farming measured as return on time.

## The scope problem, stated first

The vision is a market intelligence platform. Chip has about 1 gold 60 silver at level 20, and his best measured lever is trunk fishing at a planning range of 4 to 10 gold an hour. A platform takes two to three months, which is the length of his documented burn out cycle on new interests. The economy it was built for will have moved on by then, and most of its modules need data the API does not carry.

The version that pays this week is narrow. One house polled hourly, stored in SQLite, scanned for two things the API alone can prove, reported against the watchlist already defined in the money patterns doc. Phases 1 and 2 below do that. Everything after is optional and should only start once phase 2 has produced gold that Chip actually collected.

## VERIFIED AGAINST THE LIVE API, November 17, 2026

First real call with Chip's own credentials. These are our own observations and outrank any community report in this doc.

1. **Credentials work.** Token returns, valid 24 hours. Namespaces `dynamic-forever-us` and `static-forever-us` both answer.
2. **Rulesets return as 1, 15, 3, 2 with no names in the index.** The community report of a `name` field applies to `/data/wow/ruleset/{id}`, not to the index. So the index alone cannot tell you which ruleset is Normal. Treat ruleset 2 as Normal on community report only, unconfirmed by us.
3. **15 houses, five per faction.** Alliance 110, 111, 112, 119, 123. Horde 113, 114, 115, 120, 124. Blackwater 116, 117, 118, 121, 125. Id 122 does not exist. Five houses per faction against four known rulesets is unexplained and matters for house identification.
4. **House 110 holds 86,724 auctions at 8.2 MB, returned in 344ms.** Larger than the 50,000 to 68,000 the community reported two weeks ago. The market is growing, so size assumptions should be revisited, not fixed.
5. **Commodities are empty.** House 110 returned zero commodity entries. Forever appears to use Classic style auctions throughout, with no retail commodity system. **Consequence: a buyout prices the whole stack, so unit price must be computed as buyout divided by quantity.** Comparing raw buyouts would rank a stack of 20 as more expensive than a single unit. This is the single most dangerous bug available in this build and it would have looked like working code.
6. **`sell_price` is populated.** Item 2589 Linen Cloth returned sell 13c. **The vendor floor scanner, module M2, is confirmed buildable.** This is the green light for phase 2.
7. **`purchase_price` is not a vendor availability signal, now proven.** Linen Cloth returned a purchase price of 55c despite no vendor selling Linen Cloth. The field is a notional base value on every item. Gap 1 below is confirmed by our own data, not just by forum reports.

## What the Blizzard API gives you

1. **Auction listings per house, refreshed about once an hour.** Item id, quantity, buyout, optional bid, time left.
2. **Item data in the static namespace,** including `purchase_price` and `sell_price` in copper, item class and subclass, quality, required level.
3. **Character data in the profile namespace,** including a working professions sub endpoint, which can read Chip's actual skill levels rather than asking him. Characters only appear from level 10 and only after logging out.
4. Rulesets, auction house index, guilds, achievements, quests and media.

## What the API does not give you, and what the plan assumed it would

This is the heart of the gap analysis. Four of the vision's modules depend on data Blizzard does not publish.

### Gap 1. Vendor inventories do not exist in the API

There is no endpoint that answers which NPC sells an item, where that NPC stands, what stack size is sold, or whether stock is limited. Blizzard's own API staff have pointed developers at client file extraction for this. The item endpoint's `purchase_price` is a base buy price, and it is unreliable in three documented ways. It returns wrong values for some items, for items sold in bundles it gives the bundle price rather than the unit price, and as our own Linen Cloth check shows, it is populated even for items no vendor sells at all.

Consequence. The Bright Baubles style scan, buy at a vendor for 2 silver and sell for 5, **cannot be built from the API**. It needs a vendor table from somewhere else, and that table needs verifying in game before any gold is spent against it.

Where vendor data can come from, in order of effort. First, cMaNGOS classic\-db, a GPL licensed Classic Era database that carries vendor lists and is already used by the Forever community sites, with every row marked as Classic data to confirm on Forever. Second, Forever client tables through wago.tools. Third, Chip's own in game verification of the handful of vendors that matter. The fixed price reagent vendor already in the money docs, Mister Graphed in Powderfuse Port, is the proof that this module can pay, and also the proof that it needs exactly three rows of data rather than a world model.

### Gap 2. Recipes and reagents are not in the API for Forever

The recipe and profession game data endpoints are retail only. They were never added for Classic namespaces, and the community survey of Forever's static namespace confirms only the item endpoint. So the crafting module cannot ask Blizzard what a Crusader's Boot costs to make.

Where recipe data can come from. The Forever client's own tables, exported by wago.tools as DB2 CSV under product `wow_classic_beta`, builds 1.60.1.x. The community has already datamined 941 new Forever recipes from them. Several sites in the source library are built on exactly this pipeline. This is a real and maintained source, so the module is feasible, it just is not an API call.

### Gap 3. Farming data does not exist anywhere yet

Drop rates, spawn density, respawn timers and route efficiency are in neither the API nor the client files. Classic rates exist and are being reused by every Forever site, marked as unconfirmed. Forever specific rates do not exist because nobody has gathered enough samples.

Consequence. Return on time for farming cannot be modelled. It can only be **measured**. The honest build is a session logger. Chip records what he gathered and how long it took, the app computes gold per hour from his own numbers against live prices, and farming routes get ranked by his data rather than by a guess. This also finally closes the open trunk session log item in the money docs.

### Gap 4. Item names are missing for a large share of ids

In one survey of an EU Alliance house, 652 of 1,515 distinct item ids, 43 percent, returned 404 from the static item endpoint. The client files have the same hole in a different shape. One recent build carried 31,986 item rows but only 19,307 with names and stats, because Blizzard ships many items as server side hotfixes rather than in the client.

The resolver needs layers. Static item endpoint first. Then the wago.tools hotfix export, which is fetched with `useHotfixes=1`. Then Chip's own client cache at `Cache\ADB\enUS\DBCache.bin`, which carries whatever his client has seen. Unknown ids stay as ids and are never silently dropped, because an unnamed id with a rising price is exactly the kind of thing worth noticing.

### Gap 5. The API publishes listings, never sales

Nothing in the feed says what sold. A snapshot is a photograph of what did not sell yet. The money docs already carry this as pattern P10, but the vision does not say how the app would solve it.

It is solvable, and this is the single highest value piece of logic in the whole build. Difference consecutive snapshots per item. Units that vanish from the floor between two snapshots either sold or were cancelled. Across many snapshots that noise averages out and you get an estimated sell through rate per item per day. Without it, every margin the app reports is theoretical and the app will confidently recommend a 400 percent margin on an item that trades twice a week. With it, the app can rank by gold per day rather than gold per sale.

It costs nothing beyond storing snapshots, which the app does anyway. It just needs history, which means the clock starts the day the collector runs, and that is the real argument for building phase 1 this week rather than designing the platform for another week.

## Gaps in the logic, not the data

### Gap 6. The refresh premise is wrong

The vision says updated prices as frequently as we want. Blizzard regenerates each house's snapshot roughly once an hour and not always on schedule. Polling faster than that returns the same data. The correct design is to poll every 15 minutes with `If-Modified-Since` so that a new publish is caught within minutes of appearing, and every other poll is a cheap 304.

Anything faster than hourly has only one source, which is a manual full scan in game with Auctionator. That stays a human action, and it is the right tool for a single high stakes sell now decision. It is not a feed.

### Gap 7. Transaction costs are missing from every margin

Faction auction house cut is 5 percent per the rules doc. Deposit has been 1 copper since the November 10 hotfix. The neutral Blackwater house almost certainly charges a different cut, which is unverified and matters if the app ever recommends cross faction trade. Every profit number in the app must be net of the cut and the deposit, and must be labelled as net.

### Gap 8. The app's own recommendations move the market

If three units sit at the floor and the app tells Chip to list twenty, Chip is the new floor. Ladder depth is already a rule in the money docs. The app has to apply it as arithmetic, not as a note. Every recommendation needs the quantity it is valid for, which is a function of depth above the floor and estimated daily sell through.

### Gap 9. Competition and refill rate

A large arbitrage that stays open has a reason. Either nobody has noticed, the data is wrong, or the vendor stock is limited. The way to tell them apart is to measure how fast the floor refills after the cheap units are bought. An item whose floor returns to the old price within one snapshot is being supplied by somebody. An item whose floor jumps and stays jumped was a one off. Refill rate falls out of the same snapshot differencing as sell through.

### Gap 10. Capital, bags, level and skill are hard filters, not notes

An opportunity Chip cannot act on is noise, and noise at the top of a ranked list is worse than noise, because it trains him to stop reading the list. The ranking engine needs four hard filters before it scores anything. Gold on hand, free bag slots, character level for zone access, and profession skill for crafts. His professions can be read from the profile API rather than asked for.

This also changes the sort key. Margin percent is the wrong one at 1 gold 60 silver. The right ones are gold per hour of his time and gold per gold of capital at risk, which is pattern P8 in the money patterns doc applied as code.

### Gap 11. Freshness and expiry on every recommendation

The Loch Frenzy mistake was a stale number presented as current. The app must carry the snapshot timestamp on every line it prints, and refuse to recommend an action from a snapshot older than a set threshold. The data rules in the money doc already require stating the age of any number. The app should enforce it rather than rely on remembering.

### Gap 12. Risk is not uniform and the ranking must say so

Buying below vendor sell price is near risk free given correct data. Crafting ties up capital for hours and depends on a skill level. Farming spends time that cannot be recovered. Holding stock for the December 9 raid opening can go to zero. Four opportunities can show the same gold per hour and carry completely different downside. Score risk as its own column and never blend it into one number.

### Gap 13. The do nothing baseline

Every opportunity should be scored against Chip's current best alternative, which today is trunk fishing from the Booty Bay docks. If the app's top recommendation does not beat that, the app should say so plainly instead of generating activity. A tool that cannot admit the answer is keep fishing is a tool that will waste his evenings.

## The catch worth checking first

The money doc records Raw Loch Frenzy at a floor of 4 copper with 652 units at that price, noted as being below a 20 copper vendor price, and concludes vendor your own catch rather than list it. The buy side of that was never taken.

If the vendor sell price really is 20 copper, then 652 units at 4 copper cost 26 silver and vendor back for 130 silver. That is roughly 100 silver of profit for a few minutes of clicking, against a total net worth of 1 gold 60 silver. Either that is the cheapest money in the game right now, or the 20 copper figure is wrong and the real vendor price is 1 or 2 copper.

Both answers are valuable. Resolve it by reading `sell_price` from the item endpoint for Raw Loch Frenzy. We now know `sell_price` is populated, so this is one call away.

## Modules, with their real data source

| # | Module | Data needed | Source | Feasible |
| --- | --- | --- | --- | --- |
| M1 | Price feed and watchlist report | Auctions per house | API only | Confirmed November 17 |
| M2 | Vendor floor scanner. Buy on the auction house below vendor sell price, sell to a vendor | Auctions plus item `sell_price` | API only | Confirmed November 17 |
| M3 | Sell through, refill rate, movers week over week | Stored snapshot history | API plus local history | Yes, after a week of collection |
| M4 | Craft margin and skill up cost per point | Recipes, reagents, skill thresholds | wago.tools client tables | Yes, data sourcing work |
| M5 | Vendor supply arbitrage. Buy at a vendor, sell on the auction house | Vendor inventories and locations | cMaNGOS classic\-db plus in game verification | Yes, with caveats on every row |
| M6 | Farm return per hour | Session logs | Chip's own measurement | Only as a logger |
| M7 | Ranking engine | All of the above plus his gold, bags, level, skills | Local plus profile API | Last, not first |

## The math, net of costs

Let `unit` be buyout divided by quantity, since Forever prices the whole stack. Let `floor` be the lowest unit price among listings that have a buyout, ignoring one obvious outlier undercut. Let `cut` be 0.05.

1. **Vendor floor flip.** Profit per unit equals `sell_price` minus `floor`. No cut applies, because the sale is to a vendor. Valid quantity equals units available at or below the break even price. Risk near zero if `sell_price` is correct.
2. **Vendor supply flip.** Profit per unit equals `floor` times `(1 minus cut)` minus vendor unit cost, minus deposit. Valid quantity equals ladder depth plus estimated daily sell through, not vendor stock. Needs the stack size correction from Gap 1.
3. **Craft margin.** Profit per craft equals output `floor` times `(1 minus cut)` minus the sum of reagent costs, where each reagent costs the lower of its auction floor and its vendor purchase price when a vendor sells it. Gate on skill. Flag whether the craft also yields a skill point, because a craft that loses 2 silver and gives a point can still beat the cheapest leveling path.
4. **Skill up cost per point.** Net loss per craft divided by expected points gained at the current skill level, using Forever's recipe colour thresholds. This ranks the blacksmithing route by gold rather than by guesswork.
5. **Farm return.** Units per hour from Chip's log, times net unit revenue, where net equals `floor` times `(1 minus cut)` for auctioned goods or `sell_price` for vendored goods. Never modelled, only measured.

## Build order by effort

**Phase 0. Evaluate before building. Thirty minutes.**
A public project already does close to this. `github.com/petersutarik/wow-forever-ah` describes itself as a Forever auction house tracker and opportunity scanner, polling every 15 minutes into SQLite, with craft margins, farm rankings, a static sync for recipes and vendor reagent prices, and a history command. Unverified, unaudited, and not endorsed. Read the code before running anything that holds credentials. If it is sound it collapses phases 1 through 3 into a configuration task. If it is not, its data sourcing choices are still worth reading. Either outcome is a win for thirty minutes.

**Phase 1. Credentials and the feed. One session.**
Credentials done November 17. Remaining is a collector that polls one house every 15 minutes with `If-Modified-Since`, stores the raw snapshot gzipped, and writes per item aggregates to SQLite. Aggregates are item id, snapshot time, floor unit price, units at floor, units within 5 percent of floor, total units, listing count. A report command that prints the watchlist from the money patterns doc. TypeScript matches Chip's daily language, and the whole thing is a CLI. No web app until the data earns one.

**Phase 2. The two scanners the API alone can prove. One session.**
M2 vendor floor scanner, which needs only the item `sell_price` cached per id. Then M3 as soon as there are two snapshots, which gives sell through, refill rate and movers. Resolve the Loch Frenzy question here.

**Phase 3. Recipes. One to two sessions.**
Import the Forever recipe and reagent tables from wago.tools, compute M4 and M7. This is where the blacksmithing route stops being a guess.

**Phase 4. Vendors. Multi session, data heavy.**
cMaNGOS vendor import, flag every row as Classic data to confirm, and verify in game before spending. Start with the vendors already known to matter rather than the whole world.

**Phase 5. Farm logging. Ongoing, needs play time.**
The session logger, then real gold per hour numbers for trunk fishing and ore.

**Phase 6. Ranking engine and delivery.**
Only once at least three modules produce real numbers. Delivery is the open question below.

## Where the work happens

The code lives in Claude Code on Chip's machine, because Blizzard's hosts are blocked from the chat sandbox and an undocumented API cannot be built against without running it. The strategy, the source library, the pattern ledger, the data rules and the weekly reads stay in this project. Decisions made while coding that change strategy come back here as doc updates, or the two halves drift apart.

## Storage and operating notes

1. **Unit price is buyout divided by quantity.** Verified November 17. Nothing else in the build matters if this is wrong.
2. Keep raw snapshots gzipped on disk for 14 days, keyed by house and publish time, so the differencing logic can be rerun after a bug fix. Aggregates are small and kept forever.
3. One house hourly is roughly 24 MB of raw JSON a day before compression, at the current 8.2 MB per snapshot. Not a problem. Four houses at 15 minute polling without `If-Modified-Since` would be.
4. Pin the house id in config and assert on it. A silent switch to another Alliance house would poison every number with no visible error.
5. Never sum across rulesets. They currently return identical data.
6. Exclude bid only auctions from floor calculations.
7. The Blizzard API is sanctioned and this bot is a normal client of it. Automating anything inside the game client is not sanctioned. Everything in this build stays outside the client, and Auctionator stays a human action.

## Open questions

1. Which of the five Alliance houses is Chip's, matched against two in game prices. Blocking everything downstream.
2. Why there are five houses per faction against four known rulesets.
3. Raw Loch Frenzy `sell_price`. Confirms or kills the first real trade.
4. Whether the Blackwater neutral house charges a different cut than 5 percent.
5. Whether the profile API's professions sub endpoint returns Chip's blacksmithing and mining numbers, which would close two open items in the money docs without him typing anything.
6. Whether `wow-forever-ah` is sound enough to adopt.
7. How Chip actually reads the output while he is in game. A terminal digest, a file Claude reads in chat, a one page dashboard, or an addon import. Lowest effort first.
8. Whether wago.tools item data is accurate enough for Forever. At least one community project flags its item tables as incomplete and in places wrong.
