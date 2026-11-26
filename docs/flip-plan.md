# The Flip Engine: plan for the next phase

Version 2, November 24, 2026 (version 1 November 23, revised after Chip's answers). Planning only. Nothing here is built yet. When Chip approves it, this plan wins over `docs/build-plan.md` for everything about finding and ranking flips. The leveling planner, alerts, the map and the overnight loop stay as they are and are out of scope for this phase.

## 0. Decisions from Chip, November 24
1. **Crafting is a first class strategy, not a lesser one.** Crafting margins often exist because few people can make the item, and Chip will train alts (transmutes, enchanting) when a craft keeps showing up. Effort must never quietly bury crafting.
2. **One list, both strategies side by side.** Crafting flips and plain flips are ranked against each other on the same list. Each card is plainly marked: **green for crafting, blue for flipping.** Filters may narrow the view, but neither kind is ever tucked away on a lesser page.
3. **Only Chip's two houses count.** Alliance 111 and his one Blackwater house. Every other house is ignored for flips. Cross house means 111 to his Blackwater house and back, nothing else.
4. **No hard gold per hour floor.** His time is worth 50s to 5g an hour depending on what he is doing. Show gold per hour on every flip so they can be compared, and let what the engine finds decide later where a floor belongs.
5. **Quantity changes everything.** Buying 10 versus 100 of the same opportunity changes the profit and the gold per hour a lot, so each flip shows its numbers at several quantities.
6. **Risk per opportunity** is shown on every flip.
7. Bright Baubles not making the top 10 is fine. A flip that worked once is not proof it works every time.
8. **Crafting minutes do not matter; overnight selling does.** Chip lists and goes to sleep. The time rate defaults to 0 (minutes still shown). The horizon is his sleep window, about 10 hours, with no relisting: units others post under his price overnight count against him, and every unsold unit loses its deposit.
9. **Approved to build, November 24.** Blackwater house id comes later; the build runs on 111 until then.
10. **Local for now.** This build runs on Chip's PC, started with one command. Hosting on chipwhiteside.com is a later phase; section 12 records the recommended route for then.

### Decisions from Chip, November 26 (refresh and alerts)
11. **Hourly job.** It collects each publish and counts sales, as before, and runs the flip analysis quietly, for alerts and trends. The page still shows the newest run.
12. **Refresh button on the Flips page.** It pulls the newest publish for Chip's houses now (a 304 when nothing is new), counts sales, runs the full flip analysis and shows the result. While it works it says "Checking Blizzard..." with a spinner, then the data time and when the next publish is due.
13. **Discord alerts only for the best.** Good at 10g or more expected overnight, Amazing at 20g, both in Settings. A flip alerts only at low or medium risk, strength 75 or more, 6 hours of watched sales when it sells on a house, a known learn source, nothing holding it back, from a complete and fresh run. No cap per hour: every qualifying flip in a run goes out, one post per run, Amazing first, split at Discord's 2,000 characters. The same flip is not sent again within 24 hours unless its expected profit grew by a quarter. Quiet hours hold alerts and send them when quiet ends, if still live. Code: `src/flips/alerts.ts`, gates in `src/rules/flips.ts` FLIP_ALERTS.
14. **Old play alerts are off by default.** The Settings checkbox "Also send the old play alerts" (`play_alerts`) turns them back on.
15. **Every alert is logged** in `flip_alerts` (migration 14); `npx tsx scripts/alert-review.ts` says whether each was still live at the next publishes and whether the product sold near the claim.

## 1. The goal, in one paragraph

Every hour, at about 25 past, Blizzard publishes every listing on Chip's houses. Within minutes the engine reads all of it, joins it to a complete, verified database of recipes, vendors and items, and tests every way to turn copper into more copper: buy and resell, buy and craft, vendor to auction, auction to vendor, one house to the other. It throws out anything that is fake, too thin, or not worth his time, and shows one ranked list. The best flip is on top. He can scroll as far as he likes. Each one says what to buy, where, how many, what to do with it, where to sell it, for how much, and why the tool believes it.

**The quality bar is the flips, not the page.** A flip on the list must be real (the prices and sales behind it exist right now), profitable after every fee, sellable at the volume claimed, and worth the hours it takes.

## 2. The yardstick: two real flips and their mirror images

Chip gave two flips that clear the bar. Both have since closed, which is the point: the tool exists to catch them in the hours they are open.

| Flip | What it was | What it must do in tests |
| --- | --- | --- |
| **Cerulean Dye** (Ben's) | Alchemy. 2 Frilled Lichen at 25 to 30s each plus 1 Empty Vial (4c from a vendor), about 50 to 61s all in. The dye sold for 70 to 80s and moved fast. About 9 to 19s profit each | A recorded market at those prices **must** produce this flip, in the top 10 |
| **Bright Baubles** (Chip's) | Old Man Heming on the Booty Bay docks sells them for 2s 50c (verified in EG Link). They sold near 5s on the Booty Bay (Blackwater) house. After the 15% cut, about 1s 75c profit each | A recorded market at those prices **must** produce this flip when Blackwater sells enough a day to beat the trip and the deposit risk. The fixture states its sales a day, so the test passes or fails for a stated reason |
| **Both, today** | The prices have fallen to match cost | Today's live listings **must not** produce either one |

Checked against real data this session:
- Cerulean Dye is item 249409, an Alchemy recipe (SkillLineAbility 54453, taught at Alchemy 40 for 1s 50c). It takes 2 Frilled Lichen (249399) and 1 Empty Vial (3371) and makes 1. Blizzard's recipe API and the game tables agree.
- **No quest in any EG Link record needs Cerulean Dye.** What does need it: about 130 recipes, mostly new Forever Tailoring pieces, plus the Runecloth and Mooncloth Bags, which Forever changed to need dyes. So its demand came from crafters, not from a quest. That matters: the tool should treat "a reagent many recipes need" as a strong reason for steady demand.
- Bright Baubles is item 6532, Old Man Heming sells it for 250c at Neutral and Friendly.

## 3. Where we are: an honest audit

### What already serves the goal (keep)
1. **Live collection works.** The engine polls every house every 2 minutes, stores each hourly publish, and keeps raw snapshots for replay. Live from this session today: house 111 has about 120,000 equipment listings over 5,593 items and 92,000 commodity listings over 1,345 items.
2. **Sales are inferred carefully.** Blizzard publishes no sales. The collector compares each hour's listing ids with the last hour's, and leaves out expiries, cancels, relists and mass cancels (B17, B18). This is the only possible source of "how fast does it sell". The base is sound; holes 11 and 12 below need fixing.
3. **Prices resist trolls.** A TSM style market price (cheapest 15 to 30% of units, outliers trimmed), sold price caps, and junk gates.
4. **Vendors are right.** EG Link vendors filtered to what an Alliance character can use (Nerrist excluded, verified).
5. **Fees are verified.** 5% Alliance cut, 15% Blackwater, deposit measured from Chip's own listing.
6. **Make or buy math exists.** `src/craft/makeOrBuy.ts` walks every recipe tree and picks the cheapest of auction, vendor or craft at each node.
7. **Five detectors** produce plays: vendor dump, vendor to auction, cross house, underpriced relist, sell now.

### What does not serve the goal (the holes)
1. **Crafting flips never reach the ranked list.** `Engine.detect()` (`src/engine/engine.ts`) runs five detectors and none of them crafts. Crafting lives on a separate Profit board, sorted first by "can you make it now", which is the opposite of Chip's rule that trainable requirements never disqualify a flip. The single most important flip type is not on the main list.
2. **Bind on pickup products look sellable.** Blizzard puts binding under `preview_item.binding`, but `src/catalog/items.ts:54` reads a top level field that never exists, so binding is null on every item and every bind on pickup guard is dead. The game's own item table (`ItemSparse.Bonding` on wago.tools) is a second source to cross check it.
3. **Reagent cost ignores depth.** The board prices each reagent at one trusted price. Buying 200 Frilled Lichen walks up the listings and costs more per unit than buying 2. A volume flip looks better than it is.
4. **Sell volume is not tied to the flip.** The board shows sales a day but ranks Chip's craftable recipes first, and does not cap units by how many the market absorbs, how many units sit ahead of him, or how deep the reagent supply is.
5. **No effort model.** Nothing knows that 2,000 crafts for 2c each is a bad hour. The only guard is a flat 1s minimum profit per item, which also blocks good high volume flips at a few copper.
6. **Recipes come only from Blizzard's API,** which drops a reagent after an empty slot (White Wedding Dress loses its Bleach), stores 1 to N ranges for random yield bombs, and includes Season of Discovery recipes whose items are not in Forever (only 2,157 of 2,495 are fully live). The game tables on wago.tools are more complete and must be cross checked against it.
7. **Blackwater is not covered.** Chip's Blackwater house is still unconfirmed (P6), and once a house is pinned, only pinned houses make plays. The Bright Baubles flip was a Blackwater flip, so today it could not appear.
8. **No disenchanting.** No public source has disenchant outputs for Forever (checked today). This needs hand entry and in game proof.
9. **No conversions.** Item use crafts outside the profession tables (for example "Dust to Motes", essence combines) are not read.
10. **Reagents are costed at the wrong price.** `makeOrBuy.ts:51` prices a reagent at the trusted *sell* price, which is the lower of the market price and what it sold for (`prices.ts:58`). If Lichen sold at 20s yesterday and the cheapest listing now is 30s, the tool thinks it costs 20s and invents a flip. Reagents with under 3 listings and no sales are dropped entirely (`prices.ts:61`), blocking crafts whose reagents can in fact be bought. The buy side must read what is actually listed.
11. **Fast sellers are undercounted.** Every listing that vanishes while showing under 2 hours left is treated as expired (`aggregate.ts:122`). A 2 hour listing shows that from the moment it is posted, so every 2 hour listing that sold is thrown away, and those are exactly the fast movers. Sweeps that buy past 10% above the floor are dropped too (`aggregate.ts:128`), which is the very event that opens a Cerulean Dye style gap.
12. **Undercut wars can count as sales.** A seller cancelling to undercut is only caught on markets with 5 or fewer listings (`aggregate.ts:94`).
13. **Only 12 price levels are stored per item** (`aggregate.ts:42`). Depth walks must read the full listings, which the collector holds in memory and the raw snapshots keep on disk.

### What the current engine produces today (live run, November 23)
A fresh engine ran here against live Blizzard data across one hourly publish on all 8 houses. All 107 tests and the typecheck pass. The first run took about 3 minutes and 138 MB; each hourly detect takes about 6 seconds.
- **Plays after one hour: 23, all vendor to auction.** Best: Soothing Spices bought at 1s 60c and sold near 6s 65c, Junglevine Wine, Mild Spices, threads, vials. Real looking, and exactly Bright Baubles shaped. But "360 sold a day" came from one hour multiplied out.
- **Crafting board: 2,312 recipes tried, 518 show a profit.** The top is junk: Lionheart Helm "534g profit" on 3 listings, Stormshroud Shoulders at 1,546% margin, transmute chains priced as if they had no cooldown, 30 rows over 500% margin. Sales a day is blank on every row. This is the board Chip would see today, and it fails the quality bar.
- **Bind on pickup is never detected.** Binding is null on all 10,955 items: the code reads a field Blizzard puts under `preview_item.binding`. Every bind on pickup guard in the code is dead, and the tests set binding by hand so they never noticed.
- **"Can craft" ignores skill.** Learn skill is stored as 1 for 2,475 recipes (`recipes.ts:90`), so a Blacksmith at 125 reads as able to make 506 of 507 recipes.
- **About 3,100 items on the auction house are unknown to Blizzard's Forever item data** (404) but known to its Classic item data (for example Brawler Gloves). wago's Forever item table lacks them too. So they have no name, vendor price or binding today. This also corrects the data research: missing from wago's Forever table does **not** mean missing from the game.
- **The price junk gates block real reagents.** Strange Dust, Dream Dust and Cured Rugged Hide list deep at prices far above their 1c vendor value and are held back as trolls, blocking 100 to 215 recipes.
- **Test recipes leak in** ("Test Profession [DNT]", "Smelt Copper (Test)"), and 287 Season of Discovery recipes sit in the list.
- **Blizzard rate limits:** 983 of 8,304 item requests and 390 of 2,912 recipe requests hit 429 and only recovered by retrying. Concurrency is too high.
- **Closest calls show trolls** (a Tough Hunk of Bread at 10g).

## 4. The data: what we need, where it comes from

Two kinds of data. **Static** data changes only when Blizzard ships a build. It is downloaded, checked and stored locally, so the hourly run never waits on the internet for it. **Live** data is the hourly auction snapshot.

### Static database, refreshed daily and whenever the build changes

| Need | Source (verified today) | Why this one |
| --- | --- | --- |
| Every recipe, its reagents and quantities | wago.tools game tables for the live `wowf` build (1.60.1.71037): `SkillLineAbility`, `SpellReagents` | 2,706 profession recipes. Reads all 8 reagent slots. Matches Blizzard on 2,493 of 2,494 shared recipes |
| What a recipe makes, and how many | wago `SpellEffect` (create item), cross checked with Blizzard `/data/wow/recipe/{id}` | 0 product mismatches. Random yields (9 Engineering bombs) disagree between sources, so they are flagged until Chip crafts a few |
| Recipes wago lacks | Blizzard recipe index, as a union | Catches the rare one (Centaur Hoofwarmers) |
| Is this item really in Forever | Listed on a Forever house, or in Blizzard's Forever item data, or in wago's Forever `ItemSparse`. A recipe counts as live only if its product and every reagent pass | Blizzard's Forever data and wago's Forever table both lack about 3,100 old items that are listed on the house today, so neither alone can decide |
| Binding, stack size, vendor sell price, vendor buy price and bundle size, quality, class | Blizzard item data (binding is under `preview_item`), wago `ItemSparse` as the cross check, Blizzard's Classic item data (`static-classic1x`) as the fallback for the 3,100 old items | Two sources must agree where both exist. The Classic fallback is marked as such and its prices checked against a sample of in game vendor prices |
| Craft cast time | wago `SpellMisc.CastingTimeIndex` plus `SpellCastTimes` | Feeds the effort model. To be fetched and checked against a timed craft in game |
| Cooldowns (transmutes, Mooncloth) | wago `SpellCooldowns`, `SpellCategories` | Caps units a day for 23 profession spells |
| Item use conversions | wago `ItemEffect` plus `SpellEffect` | Dust to Motes and similar. Only Forever live items kept |
| Vendors, prices by standing, limited stock | EG Link vendors (already used) | 1,062 gold priced items. 82 of 589 reagents are vendor sold. Limited stock has an observed max but no restock timer |
| Where and for how much a recipe is learned | EG Link trainers (already used), recipe items from `ItemEffect` | One time setup cost shown on the flip, never a reason to hide it |
| Why people buy it | EG Link quests (already used), plus "number of recipes that use it" | Demand reason on the card |
| Disenchant outputs | None published. Hand entered classic table, marked unverified until checked in game | Phase 2 of this plan |

Every source is fetched, validated against a data contract, compared with the second source where one exists, and written to SQLite with its build id. A recipe the two sources disagree on is kept and flagged, never silently dropped or silently trusted.

### Live data, every hour
The commodities and equipment snapshots for Alliance 111 and Chip's one Blackwater house, and no other house. Until the Blackwater house is confirmed (section 10), the candidate Blackwater houses are still collected only so the house finder can match it; none of them produces flips. Once it is confirmed, the others stop being collected.


### New data the engine must start recording
1. **When each listing was first seen,** and its first time left reading. Then "did it expire or sell" is predicted from its age, instead of throwing away every 2 hour listing.
2. **How Forever's 2, 8 and 24 hour listings map to SHORT, MEDIUM, LONG and VERY_LONG.** One listing of each length by Chip, read back from the API.
3. **Equipment modifiers.** Print one real equipment auction record and check for suffix or bonus fields before treating all copies of an item as one market (ledger rule 1).
4. **The Blackwater deposit (T7).** It now decides whether Bright Baubles was worth it: if the 5 times multiplier is real, an expired 2 hour listing loses about 1s 24c a unit.
5. **Chip's own trades,** so his buys are not counted as market demand, and so his mailbox (sold or expired) becomes ground truth for the sales counter.
6. **His reaction time,** roughly how long after a publish he can act. The backtest uses it.

## 5. How the engine finds every flip

### The idea: two books, every flip a path between them
For every item the engine builds two things each hour.

**The cost book: what the next unit of it costs to get.** Not one price but a curve, cheapest unit first:
- **Auction:** the actual listings, raw and untrimmed, on either of Chip's two houses. The 200th Frilled Lichen costs what the 200th listing asks. Troll checks never apply here: if it is listed, it can be bought.
- **Vendor:** a flat price from a usable vendor, in its bundle size (vials come 5 at a time), capped by limited stock.
- **Craft:** the k th craft costs its reagents at their next units on their own curves, recursively, so smelting bars competes with buying bars on real numbers.
- The item's curve is the cheapest mix of the three. Within one recipe tree, shared sub reagents are allocated once (Copper Bar used directly and inside Bronze Bar does not get the same cheap listings twice).

**The sell book: what the next unit nets when sold.** The troll proof judged price (exists), after the cut, never above where real sales happened, on either of Chip's two houses, or the vendor price. Plus how many units sit ahead of Chip at that price and how fast they clear (section 6).

Every flip is a path from one to the other, so a Cerulean Dye and a Bright Baubles are judged by the same rules.

### Flip families, all on one list

| Family | Card color | Path | Status |
| --- | --- | --- | --- |
| **Craft to auction** | Green, crafting | Buy reagents (any depth) → craft → sell on one of his two houses | **New on the main list.** The core of this phase. Smelting, cooking, first aid, alchemy, tailoring and the rest |
| **Craft to vendor** | Green, crafting | Buy reagents under the product's vendor price → craft → sell to any vendor | **New.** No cut, no competition, no limit on sales. The cleanest "tiny margin, huge volume" flip, limited only by reagent depth |
| **Conversion** | Green, crafting | Item use crafts (Dust to Motes, essences) | New, after craft. Containers such as clams only if their contents are proven in data |
| **Disenchant** | Green, crafting | Buy green gear → disenchant → sell dust and essences | New, last, labelled unverified until proven in game |
| **Vendor to auction** | Blue, flipping | Buy from a usable vendor → sell on one of his two houses (Bright Baubles) | Exists. Extended to his Blackwater house |
| **Auction to vendor** | Blue, flipping | Buy under vendor price → sell to any vendor | Exists |
| **Cross house** | Blue, flipping | Buy on 111 → sell on his Blackwater house, or the reverse. No other house | Exists, limited to his two houses |
| **Cheap listing** | Blue, flipping | Buy well under the usual price → relist on the same house | Exists |

Deliberately left out: market resets (buying out a whole market to relist higher). Too much gold at risk on hourly data.

Each flip is tagged **repeatable** (a vendor or deep reagent supply that refills, like Bright Baubles) or **one opening** (cheap listings that are gone once bought). Only repeatable flips show a per day figure.

### How a craft flip is computed, step by step
1. Take each live recipe whose product can be sold (not bind on pickup per ItemSparse, priced on a house or by a vendor).
2. **Sell side.** Judged price per house, units ahead, sales rate, so a sell curve: how many Chip can sell within the horizon at what net.
3. **Cost side.** The cost curve of each reagent.
4. **Best quantity.** Add one craft at a time while the next craft's sale (times its chance of selling, minus the deposit lost if it does not) still beats the next craft's reagent cost plus its time. Stop at cooldowns, vendor stock and gold on hand.
5. **Fixed costs** (a trip, a trainer, a recipe) are subtracted after. A flip at or under zero after them is held back.
6. **One time setup** is shown (where to train, what it costs), never a reason to hide it.
7. Random yield recipes (9 Engineering bombs) stay flagged and out of the ranking until their yield is proven.

## 6. How the engine ranks them: the theory

What makes a flip good, in Chip's words: it makes real money, it sells, and it is worth the time. Turned into numbers:

### The rank: expected profit if Chip acts now
For the best quantity N, over Chip's overnight window (10 hours by default, a setting), with no relisting in that time:

**Expected profit = for each unit: chance it sells × net sale − its cost − chance it does not sell × deposit lost, minus minutes of work × a time rate.**

Highest first. This one number does four jobs:
- **Time is shown, not charged, by default.** Chip crafts and lists, then sleeps, so crafting minutes do not cost him money. The time rate is a setting that defaults to 0; minutes stay on every card. 2,000 crafts for 2c each is no longer removed for effort; it simply makes 40s and ranks near the bottom by its own small profit.
- **Volume is built in.** Units only count if they are likely to sell inside the horizon.
- **Depth is built in.** Each unit carries its own real reagent cost.
- **Listing risk is built in.** A unit that may not sell carries its lost deposit.

The inputs are deliberately cautious: sales a day uses a low estimate from the sales actually seen (few sales means a wide range, so a low number), and the sell price assumes one typical undercut. That stops the list from rewarding the flips whose numbers are most overestimated, which is the classic trap of sorting by noisy estimates.

### Gold per hour, shown on every flip, never a gate
Expected profit divided by the minutes it takes: crafting time from each recipe's real cast time, plus buying, posting and any trip. Shown next to the profit so a 3g flip that takes 5 minutes and a 4g flip that takes an hour can be compared at a glance. No floor for now; once the engine has run for a while, the run reports will show where good flips actually sit, and Chip decides then whether a floor helps.

### Quantity: the same flip at 10, at the best amount, and at the most
Each flip shows a small table at three or four quantities, for example 10, the best amount, and the most the market can take: units, total cost, expected profit, gold per hour, and risk. Buying more walks up the reagent listings and pushes deeper into the sales queue, so profit per unit falls and risk rises; the table makes that trade visible. The list ranks each flip at its best amount.

### Refinements from the first independent test (November 24)
The first test round recomputed 13 flips to the copper, then showed the market model trusting too little evidence. Now:
1. **Sales need 6 hours of watching** before an auction flip ranks. Until then it is held back as "learning".
2. **The cautious sales estimate counts sale events, not units.** Three stacks vanishing is three events, however big the stacks.
3. **New listings overnight are measured** from the units other sellers actually post each hour, never guessed.
4. **The chance each unit sells falls smoothly** with how many he posts, so big deposits pull the best amount down.
5. **Unsold units** are valued at what a vendor pays, minus the lost deposit, in both the expected and the bad case.
6. **Bad case** = price drops to its 3 day low (25% when there is not 3 days of history) and only half the expected units sell. Deposits count in gold at stake.
7. **Price wars are named:** a floor that fell this hour under a flood of new listings is a risk driver, not demand.
8. **Fresh gate:** a run on data over 2 hours old is incomplete.

### Refinements from the second test rounds (November 25)
1. **Unsold stock is priced through tomorrow's queue,** not assumed to sell. A flip that mostly sells tomorrow says so and is at least medium risk.
2. **Competition counts only listings at or under your price,** and needs 6 hours of watching like sales do.
3. **Every profession a craft needs is listed** (a setting can limit sub crafts to your professions; a top recipe is never blocked).
4. **Unknown learn source is shown and is a risk.**
5. **Cooldowns cap crafts within one craft session.**
6. **Vendor prices only from Forever data.** Items whose vendor price exists only in Classic data are held back until checked in game. Vendor flips need at least 5c and 5% margin.
7. **Market evidence wins on binding:** an item listed on your house in the last day is tradeable, whatever a table says.
8. **Steamwheedle towns are neutral** (Booty Bay, Ratchet, Gadgetzan, Everlook), never for an NPC recorded as Horde.

### Refinements from the third test round (November 26)
1. **The queue runs on the low estimate.** Sales tonight and tomorrow use the cautious number, never the middle one. Two repricing events no longer make a 500g flip.
2. **A recipe item nobody sells or drops** reads "how to learn it is not known yet" and is a risk.
3. **Cooldowns wait while learning.** A cooldown craft is not sold to a vendor while its auction price is over twice as high and still being learned.
4. **No second deposit while a listing is still up.** A 24 hour listing covers the first 14 hours of tomorrow.
5. **The bad case clears the units ahead at its own slower rate,** and the small row stays inside one crafting session.

### In game checks for Chip (each settles a ledger row)
1. Vendor one Seasoned Wolf Kabob and one Barbaric Shoulders: does the vendor pay what the tool says?
2. List one item each at 2, 8 and 24 hours on Alliance and on Blackwater: note the deposits (settles T7).
3. Craft Coarse Dynamite a few times: how many each time?
4. Buy from one vendor in Ratchet, Gadgetzan and Everlook (Booty Bay is proven).
5. Tell the tool your Blackwater house (Booty Bay screenshots with prices).

### How many Chip can sell: a queue, not a flat 20%
Units Chip can sell within the horizon at price p = low estimate of sales in that time − units listed below p − new units other sellers post at or under the floor in that time (already measured hourly as new units). The card reads, for example: "180 ahead of you, about 60 sell a day, you can expect to sell 25 in 24 hours." The 20% share stays as an upper bound until the backtest proves the queue is better.

### Risk per opportunity
Every flip carries a risk line in gold and plain words, computed at each quantity in the table:
- **Gold at stake:** the total cost to do it.
- **Bad case loss:** what happens if the product price falls to its low over the last 3 days and only the low estimate of units sells in 24 hours. Unsold units are valued at what they can be salvaged for (vendor price, or the reagents' value if that is the only honest fallback, which for a crafted item is usually nothing). Deposits on unsold listings are lost. Shown as "you could lose up to 1g 20s".
- **Days to sell:** units ahead of him plus his units, divided by the low estimate of sales a day.
- **What drives it:** a jumpy price, few sales seen, many units ahead, thin reagent supply, or a price that just jumped.
- **Risk level:** low, medium or high, from the bad case loss against the expected profit. A flip whose bad case loses more than it is expected to make is high risk.

Risk does not hide a flip. It is shown beside the profit so Chip can choose between a safe 2g and a risky 5g. Once the backtest exists, the measured outcomes per risk level replace these first rules.

### Trends: is this craft worth training an alt for
Each flip shows how often it has been open: "open 31 of the last 72 hours" or "new this hour". A craft that keeps reappearing is worth training a skill or an alt for, so each crafting card also shows the one time setup (trainer, cost, skill needed) next to how much the flip has been worth over the past week. A craft that pays back its setup in its first week reads as such.

### Gates (held back with the reason shown)
1. **Real.** The sell price passes the junk checks and real sales were seen near it.
2. **Profitable with room for an undercut.** The safety margin is this item's own typical undercut and price wobble, measured from its history, not a flat percentage. A steady commodity can pass at a few copper; a jumpy one needs more room.
3. **Sells.** The low estimate is at least 1 a day.
4. **Possible.** Every reagent has a source and the product is not bind on pickup. Trainable requirements never fail this.
5. **Fresh.** Built from this hour's snapshot. Closed at the next publish when the gap is gone.

The 1s minimum profit setting stays exactly as is for the Now page. The Flips list uses expected profit after the time rate instead.

### Strength stays, in a different job
The 0 to 100 strength score keeps its breakdown on the card and works as a gate (below 40 hidden, as today). It no longer multiplies gold: it is a sum of evidence points, not a probability, and its "days of history" part would punish exactly the fresh openings Chip wants. Once the backtest has a week of results, each strength band gets a measured discount (what flips in that band really paid against what they claimed) and the rank uses that.

### Catching the opening without letting trolls in
An opening from **cheaper reagents** is safe on sight: what is listed can be bought.

An opening from a **product price that just jumped** has no sales at the new level yet, so the sold price cap would hide it. The fix:
- Record the highest price buyers actually paid in the last hour. A sweep that bought up the listings to price X is real demand at X.
- A **rising** flip is allowed only when the sweep reached the new level, the level is within the highest price sold in 7 days or backed by that sweep, and the flip still makes money at the proven price.
- It ranks on the proven price and shows "up to" the new one.
- Listing counts alone never prove a price: there are no seller ids, so one troll can post three listings.

### Flips that share reagents, buyers or gold
Frilled Lichen feeds about 130 recipes, and a product can be made by several recipes or flipped several ways. Each card keeps its own standalone numbers. Then a second pass walks the list top down: each flip takes the reagent listings, sale capacity and gold it uses, and the next one is re scored on what is left. Cards show "shares Frilled Lichen with #4". Any total on the page uses the second pass numbers. Gold on hand caps each flip by its full cost to do, not just the first buy price (today's cap at `engine.ts:120` uses the buy price, which is wrong for crafts).

### Worked through on the yardstick
The fixtures state every input, so each gate passes or fails for a stated reason.
- **Cerulean Dye at Ben's prices:** about 57s in, 75s sale, about 71s net after 5%, about 13s 54c each. With 60 sold a day and 12 new listings a day under him, about 20 sell tonight and the rest the next day once relisted. The best amount is the most expected profit whose risk is not high: 22 crafts, 19 expected to sell tonight and 3 tomorrow, expected profit 2g 87s 21c, bad case 2g 74s 5c (the 70s low and half the sales on both days), medium risk. Buying the whole lichen ladder (38 crafts) would expect 4g 4s 85c but is high risk, so it is shown as the "most profit, higher risk" row. Two purchases, 22 crafts, one post: a few minutes. Green card, near the top. (Numbers from the yardstick test, recomputed independently; round 5 of the build, November 26.)
- **Bright Baubles at Chip's prices:** 2s 50c in, 5s on Blackwater, 4s 25c net after 15%, 1s 75c each. It shows only if Blackwater sells enough of them a day to beat the trip to the docks and the deposit risk. That depends on the unverified Blackwater deposit (T7). The fixture states its sales a day, and the test will say honestly which way it goes.
- **2,000 crafts for 2c each:** 40s of profit. Shown, ranked far below anything worth gold, with its 100 minutes of casting on the card.
- **Today's live dye and baubles:** no profit after the cut. Held back: "no profit after the cut".

## 7. The hourly loop
1. Publish detected (about :25). Snapshot stored, listing ages updated, sales counted.
2. Sell book for both houses: judged prices, sales, units ahead, sweep highs, steadiness.
3. Cost book: every item's cost curve from raw listings, vendors and recipes, built once and shared by every recipe.
4. Every family over every item and recipe. Best quantity, gates, expected profit.
5. Second pass for shared reagents, buyers and gold.
6. Store the ranked list, lifecycle (new, live, fading, gone) keyed per recipe.
7. Run report: items read, recipes tried, flips found, held back by reason, time taken, and every zero, empty or missing source flagged as a suspected bug.

**Correctness over speed.** No time limit ever cuts a run short. Every run covers every item, every recipe and every vendor. Run time is logged so slowness can be investigated, never trimmed. A run that cannot finish properly shows "incomplete" and why, never a partial list as if it were whole.

## 8. Current code: what stays, what changes, what is new

| Area | Verdict | Change |
| --- | --- | --- |
| Collector and snapshots (`src/engine`) | **Stays** | Record listing first seen time. Read both houses for flips |
| Sale counting (`src/analysis/aggregate.ts`, `history.ts`) | **Changes** | Expiry from listing age, not the SHORT or MEDIUM label. Count commodity sweeps past +10%. Catch undercut cancels on deep markets. Hourly sanity bound: sold never more than old units plus new minus current. Leave out Chip's own trades |
| Price rules, fees (`src/rules`) | **Stays, grows** | Protected. New constants for horizon, hourly rate, effort times, undercut margin, added with Chip's approval of this plan |
| Item catalog (`src/catalog/items.ts`) | **Changes** | Read binding from `preview_item`, cross check with ItemSparse, fallback to Classic item data for the 3,100 unknown items, every product and reagent resolved (not only items seen on the house), slower request rate |
| Recipes (`src/datasets/recipes.ts`) | **Changes** | Primary source wago tables, Blizzard as cross check and union, disagreements flagged, cast times and cooldowns added, real learn skill (trainer rank, else yellow), test and Season of Discovery recipes removed |
| Make or buy (`src/craft/makeOrBuy.ts`) | **Changes** | Cost curves from raw listings instead of one trusted price. Profit board keeps every column (page contract) |
| Detectors (`src/detectors`) | **Stays and grows** | Existing families move onto the shared books and scoring. New craft, craft to vendor and conversion families |
| Ranking | **New** | `src/flips/`: cost book, sell book, queue, effort, gates, expected profit, second pass. Pure functions, fully tested |
| App | **Grows** | A new **Flips** page, first in the menu: one ranked list with crafting (green) and flipping (blue) side by side, each card showing kind, profit, gold per hour, risk, the quantity table, how often it has been open, and setup for crafts. Filter chips for crafting, flipping and each house; none is hidden by default. Nothing on Now, Crafting or the play card is removed or moved (additive rule). Page contract and its test gain the Flips page |
| Leveling, map, alerts, overnight loop | **Untouched** | Out of scope this phase |

## 9. How every piece gets checked, at least three times

Each layer gets three independent checks: a test with hand calculated numbers, a check against live data, and a fresh agent with no stake in the code that reviews it and recomputes its output its own way. Then all layers are checked together the same way.

| Layer | Check 1: tests | Check 2: live | Check 3: independent |
| --- | --- | --- | --- |
| Static data | Data contracts; 20 known recipes by hand (Copper Bar, Minor Healing Potion, Linen Bandage, Cerulean Dye...) | wago against Blizzard, recipe by recipe, every disagreement listed | Agent checks 30 random recipes against the raw files |
| Sale counting | A small simulator for the sale counter only: synthetic posts, 2/8/24 hour listings, sweeps, undercut cancels, expiries, post and sell inside one hour, all with known truth. Bias and error reported per market type, with pass marks | Real snapshots: the hourly sanity bound never breached; Chip's own listings counted correctly | Agent recomputes 20 items' sales from raw snapshots by its own code |
| Cost and sell books | Ladder walks by hand. Properties: a higher reagent price never raises profit; a listing above the floor never raises the claimed price; splitting a listing changes nothing | Every item on both houses has a book entry or a stated reason | Agent recomputes 20 cost curves from raw JSON |
| Flip finding and ranking | **End to end goldens**: real recorded snapshot sequences with Chip's prices injected, run through the sale counter and the whole engine (nothing stubbed). Cerulean Dye in the top 10; Bright Baubles judged by its stated inputs. **Near misses**: Lichen at 36s (gone), the dye selling 1 a day (weak or gone), one troll dye at 5g and a three listing troll (price unchanged), today's prices (held back, "no profit after the cut"). **Today's junk must stay out**: Lionheart Helm on 3 listings, transmute chains with no cooldown, a bind on pickup product, Strange Dust blocked as a troll. **Scenarios**: huge volume tiny margin (shown), 2,000 crafts for 2c (ranked near the bottom by its small profit), a cheap craft with a good margin ranks against an equal plain flip on profit alone (crafting never buried by its effort), a flip on any house other than Chip's two never appears, risk rises with quantity, a price that just jumped shows high risk. Properties: the second pass never hands out more units than are listed; rank rises with volume | Full run over every recipe and item; top 25 each traced to its evidence | A separate script by a different agent recomputes the top 25 from raw JSON and must agree. A second agent argues against each of the top 10, and any argument it wins becomes a test |
| Whole loop | `npm test`, typecheck, replay, page contract test | The engine runs here on live data across many publishes | A final fresh reviewer reads the whole change and the run reports |

**Paper trade backtest, the real score.** For every flip shown at hour T: Chip acts 30 to 60 minutes later and pays the next snapshot's prices; his units sell only after the units ahead of him clear. Report what it would have really paid against what it claimed, per strength band. Also track flips that were held back and turned out good, the misses. **Rank stability:** how much the top 25 churns hour to hour on quiet markets, which exposes noise driven ranking. Once Chip trades from the list, his mailbox is the final truth.

## 10. What I need from Chip

One question now. The rest can wait.

Answered November 24: time is worth 50s to 5g an hour, no hard floor, and crafting minutes do not matter because he lists overnight. The time rate defaults to 0. Gold per hour and minutes are shown on every flip, never used as a cutoff. Plan approved to build.

Later, not blocking:
1. Your Blackwater house id. Without it, Blackwater flips like Bright Baubles cannot be shown. A few Booty Bay screenshots with prices settle it, as they did for 111.
2. One listing each at 2, 8 and 24 hours on Alliance, and one on Blackwater, with the deposit you paid. Settles the time left mapping and T7.
3. Craft Coarse Dynamite a few times and note how many each gives.
4. Time one craft batch and one posting session, to tune the effort model.

## 11. Build order after approval
Each step runs its full check loop (section 9) before the next starts. Agents work in parallel where steps do not depend on each other: one on static data, one on sale counting and its simulator, one on the books, then one on families and ranking, with fresh reviewer and recompute agents on each.

1. Static database from wago and EG Link, binding fix, live filter, cross check against Blizzard.
2. Sale counting fixes with the simulator, listing ages. Start the live collector here immediately so real history builds while the rest is built.
3. Cost book and sell book from raw listings, Chip's two houses only.
4. Craft and craft to vendor families, then the existing families moved onto the shared books.
5. Queue, effort, gates, expected profit, quantity table, risk, how often open, second pass, run report.
6. Flips page with green and blue cards side by side, page contract and its test updated.
7. End to end goldens, near misses, scenarios, independent recompute, paper trade backtest on the history collected here.
8. Conversion family, then disenchant behind the unverified label.
9. Tutorial walkthrough for Chip, including how to start it locally.

## 12. Live on the web (later phase, not this build)
Chip wants it on chipwhiteside.com eventually. Recommended route when that time comes: a small always on server (Hetzner or Fly.io, about $5 a month).
1. A container image with the engine, the app and Node, plus a persistent disk for `DATA_DIR`.
2. Secrets (Blizzard, Discord) as server environment variables, never in the repo.
3. A login in front of the app (Cloudflare Access, or one shared password) so only Chip and his brothers see it.
4. His domain or a subdomain pointed at the server, with HTTPS.
5. A one page guide: create the server account, paste secrets, point the domain. About 15 minutes of Chip's time; account creation cannot be done for him.
6. Why not Vercel alone: the engine polls every 2 minutes and keeps a database and raw snapshots on disk, which serverless functions cannot do. A Vercel front end with Supabase is possible later if he wants it inside an existing site, but it is a rewrite.
