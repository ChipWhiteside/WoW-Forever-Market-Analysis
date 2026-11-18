# WoW Forever Gold Finder: Product Spec

Product lead document. Says what the tool does, how it behaves, how it looks and how fast it must be. It does not say how to build it. Claude Code owns the how. Where this doc and the older app spec disagree, this doc wins.

## 1. What Chip asked for

Read this first. If any line is wrong, the rest of the doc is wrong.

1. **The goal is gold now, in phase 1.** The market is early and chaotic, which means mispricings appear constantly and disappear within hours. The tool exists to find them on purpose instead of stumbling on them.
2. **The edge is information and timing,** not hoarding. Bright Baubles worked because Chip saw a vendor item selling at twice its vendor price at the right moment. By the next morning the gap had closed.
3. **Five ways to make money, all in scope.** Buy from a vendor and sell on the auction house. Buy on the auction house below what a vendor pays and vendor it. Buy underpriced listings and relist higher. Buy reagents and craft something worth more than they cost. Gather or farm, measured as gold per hour.
4. **The information he wants** for every item. The lowest price, how many units sit at each price, how deep the ladder goes, how fresh the number is, what a vendor pays for it, what a vendor charges for it and where, which recipes make it and what they cost to make, which recipes use it.
5. **Phase 2 comes later.** When the market matures and players reach 60 and raids open on December 9, strategy shifts toward crafting and professions. Phase 1 must not block phase 2, but phase 2 is not built now.
6. **Strategy is decided.** This doc executes the plan. It does not relitigate it.

## 2. The experience in one paragraph

The tool runs quietly on Chip's PC. Every hour Blizzard publishes a fresh snapshot of his auction house. Within minutes the tool has read every listing, checked every item against vendor prices, recipe costs and recent history, and found anything worth his time. If something clears his profit bar, his phone buzzes with one sentence saying what to buy, how many, the most to pay, and what he makes. He opens it, sees the play laid out step by step, does it in game, and taps done. Everything else stays quiet.

## 3. The opportunity types

Each type is a separate detector with its own rules. Every one of them obeys the data rules already binding in the market doc. Lowest listed price only, never median. Ladder depth always shown. Every number carries its age.

### O1. Vendor dump (auction house to vendor)

**Question.** Is anyone listing an item below what a vendor will pay for it?
**Rule.** Any listing whose unit price is below the item's vendor sell price.
**What Chip does.** Buy every unit under the line, sell them to any vendor.
**Risk.** None, given correct data. Every vendor in the game buys almost everything at the listed sell price, so no location research is needed.
**Known limit.** If the game enforces a 1 silver minimum listing price, as some players report, then no listing can sit below a vendor price under 1 silver, and this detector only ever finds items that vendor for more than that. The detector works either way. Its yield depends on the answer.
**Captured profit.** Sum over qualifying units of vendor sell price minus listing price.

### O2. Vendor supply (vendor to auction house)

**Question.** Is an item that a vendor sells listed on the auction house well above the vendor's price?
**Rule.** Auction house floor, after the cut and deposit, exceeds the vendor's price per unit.
**What Chip does.** Buy from the named vendor, list at or just under the floor.
**Risk.** Low to medium. The floor can fall before he gets back from the vendor, and he becomes the new floor if depth is thin.
**The Bright Baubles detector.** This is the type that would have found it on purpose. It also catches the moment a gap opens, because a vendor item whose floor jumps far above its vendor price is the signature.
**Three tiers, always labelled.** Recorded in Forever, where a player's addon saw the vendor selling it in this game, with price, position and stock flag. Classic only, where an older database says this NPC sold it but no Forever recording exists yet. Candidates, where the item merely has a vendor purchase price, which Blizzard populates even for items no vendor sells. Only the first tier can raise an alert by default.
**Reputation pricing.** Vendor prices vary by standing. The tool prices each play at Chip's recorded standing, or at the worst listed price when it does not know.
**Promote with one tap.** When Chip sees a vendor in game, he can mark the item confirmed, which lifts it into the top tier for him.

### O3. Underpriced listing (auction house flip)

**Question.** Is something listed far below what it normally sells for, with enough demand to resell it?
**Rule.** Floor sits well below the item's recent normal floor, and the item has a track record of selling through at the normal price.
**What Chip does.** Buy the cheap units, relist at the normal price.
**Risk.** Medium. Depends on resale. Needs history, so this detector is dark for the first days of collection and says so rather than guessing.

### O4. Craft margin

**Question.** Can Chip make something for less than it sells for?
**Rule.** Product floor after the cut, times output quantity, exceeds the cheapest way to obtain every reagent, where each reagent costs the lower of its auction floor and its verified vendor price.
**Gates.** The product must be tradeable. Chip must know the recipe or be able to learn it, and his skill must be high enough. A bind on pickup product is never shown as a sale.
**Bonus signal.** A craft that loses a little but grants a skill point is shown as cheap leveling, priced in gold per skill point.
**Two views.** What Chip can craft today, and what is profitable for anyone, which is the phase 2 shopping list.

### O5. Farm and gather return

**Question.** What is an hour of gathering worth right now?
**Rule.** Chip's own logged sessions, items gathered per hour times current net value. Never modelled from drop rates, because no Forever drop rate data exists.
**What Chip does.** Starts a session, plays, ends it, enters what he got. The tool prices it and keeps a running gold per hour per activity.

### O6. Sell now (spike on something he has)

**Question.** Has something he holds or can easily get just spiked?
**Rule.** A watchlist item's floor jumps far above its own recent normal.
**What Chip does.** Sells into it.

## 4. How opportunities are scored and ranked

1. **Net, always.** Sale side times one minus the auction house cut, minus deposit, minus buy cost. Never a gross number on screen.
2. **Capturable, not theoretical.** Quantity is the smallest of units available under break even, what Chip can afford with the gold he has set, the bag space he has set, and for resale types, what the market will absorb before the next snapshot.
3. **Ranked by gold per minute of his effort.** Each type carries an effort estimate. Vendor dump at the auction house is about two minutes. Vendor supply includes a trip, shown as the trip ("needs a run to Booty Bay").
4. **Confidence on every card.** High when it is pure math on verified data (O1). Medium when it depends on resale (O2, O3, O6). Low when any input comes from unverified data, such as a candidate vendor item or a Classic fallback recipe threshold.
5. **Expiry.** A card stays live until a newer snapshot shows the gap closed. Then it is marked gone, not deleted, so Chip can see what he missed and how long gaps last.
6. **Outlier rule.** A single listing far below everything else counts, but is flagged, because it may be one player's mistake that is already bought.
7. **Profit bar.** Chip sets the minimum captured profit for an alert. Default is 25 silver, deliberately low because his working capital is under 2 gold. He raises it as he grows.

## 5. Screens

### 5.1 The feed (home)

One line per live opportunity, sorted by gold per minute of effort. Each line shows the profit in gold, silver and copper as the biggest thing on it, then the item, the type, the action in a few words, the quantity, confidence, and age of the data. Gone opportunities collapse below a divider for the rest of the day.

Filters across the top. Type, confidence, needs a trip or not, fits current gold.

### 5.2 The play (one opportunity, opened)

Written as instructions, not data. Example.

> **Buy up to 34 Linen Cloth at or below 12c. Vendor them anywhere.**
> Profit after costs about 1s 2c. Data is 6 minutes old. Confidence high.

Below that, the ladder for this item (each price step and how many units sit at it), a small chart of the floor over the last week, the vendor price, and for O2 the vendor's name, zone and coordinates. Buttons for done, skipped, and gone when he got there.

### 5.3 Item lookup

Search any item by name. Shows floor, ladder, total units, history, vendor sell price, vendor purchase price with whether any vendor is known to stock it, which recipes make it and their cost to make, and which recipes use it.

### 5.4 Craft board

Every recipe in every profession. Default view is Chip's own professions at his skill, sorted by profit per craft. Columns for cost to make, sell floor, net, depth on the product, and gold per skill point. A toggle shows every profitable recipe regardless of whether Chip can make it.

### 5.5 Vendor board

Every verified vendor item with its vendor price, its auction floor, and the gap after costs. A second section lists candidates, clearly labelled as unverified, so Chip can research the promising ones himself and promote them to verified with one tap once he has seen the vendor.

### 5.6 Farm log

Start, stop, enter results. Shows gold per hour per activity, best activity this week, and how today compares with his trunk fishing baseline.

### 5.7 Watchlist

Items Chip pins. Each gets an alert rule (above a price, below a price, spike). Seeded with the existing watchlist from the money patterns doc.

### 5.8 Profile and settings

Gold he is willing to deploy, free bag slots, character level, professions and skill, which detectors are on, profit bar, alert cap per hour, quiet hours. Kept to one screen.

## 6. Alerts

1. **On his phone and his desktop.** The phone is the one that matters, because he is usually in game when an opportunity appears.
2. **One sentence each,** the same headline as the play card. Tapping it opens the play.
3. **Capped.** At most five an hour by default, highest captured profit first. Anything that misses the cap still appears on the feed.
4. **Quiet hours** respected.
5. **No repeat** for the same opportunity unless its profit grows meaningfully.

## 7. How it should look and feel

1. **A trading terminal, not a website.** Dark, dense, scannable, nothing decorative.
2. **Money in game format.** Gold, silver, copper with their coin colours, so a number reads the same as in the auction house window.
3. **The profit number is the hero** on every line and card.
4. **Plain verbs.** Buy, vendor, list, craft, go. No jargon on the cards.
5. **Honest about uncertainty.** Confidence and data age are always visible, never buried.
6. **Phone view** shows the feed and the play only. Everything else is desktop.

## 8. Speed and reliability targets

| Moment | Target |
| --- | --- |
| Blizzard publishes a snapshot to opportunities on the feed | under 3 minutes |
| Snapshot published to alert on phone | under 5 minutes |
| Feed and item lookup open | under 2 seconds |
| Craft board for all professions | under 5 seconds |
| Missed snapshots per day while the PC is on | zero |
| History kept | every hourly floor and ladder summary, forever |

If a snapshot is late or missing, the feed says so at the top instead of quietly showing stale cards.

## 9. Data inventory

Every piece of information the six detectors need, where it comes from, and how sure we are. Researched and tested November 18.

**Tags.** **Verified** means we pulled it ourselves and inspected the result. **Obtainable** means the source is located and a sample was inspected, but it is not wired in yet. **Provisional** means secondhand, Classic fallback, or conflicting, and must not drive money without a check. **Missing** means no source exists and the tool or Chip has to create it.

### 9.1 Market data

| Need | Used by | Source | Status |
| --- | --- | --- | --- |
| Lowest price, units at each price, total units, listing count, for raw materials and stackables | All | Blizzard API commodities endpoint per house | **Verified.** Price is already per unit |
| Same for equipment and other single items | All | Blizzard API auctions endpoint per house | **Verified.** Every listing is quantity 1 |
| Snapshot time and refresh rhythm | All | Blizzard API `Last-Modified` header | **Verified.** About hourly per house, unchanged requests return a cheap "not modified" |
| Which house is Chip's | All | Chip, once, in game | **Missing.** Blocks every number |
| Price history per item | O3, O6, scoring | The tool's own archive | **Missing until R1 runs.** Nobody publishes per house history, so backfill is impossible. The archive is the moat |
| Number of sellers | Nice to have | None | **Not available.** Blizzard does not publish seller identity. Listing count is the only proxy and can be gamed by one seller posting many stacks |

### 9.2 Item facts

| Need | Used by | Source | Status |
| --- | --- | --- | --- |
| Name, quality, class, required level | All | Blizzard item endpoint, Forever namespace | **Verified** for names. Other fields **Provisional** until printed from a Forever response |
| What a vendor pays for it | O1, O5 | Item endpoint `sell_price` | **Verified.** Blizzard changes these in hotfixes, so the tool refreshes them daily and treats a change as news |
| Binds on pickup or equip | O4, O2 | Item endpoint, `preview_item.binding` per a published response from the same API family | **Provisional** until seen in a Forever response. Decides whether a craft can be sold at all |
| Maximum stack size | Bag math | Not in the API, which only says stackable or not | **Provisional.** Largest stack seen listed is a lower bound |

### 9.3 Vendor data

| Need | Used by | Source | Status |
| --- | --- | --- | --- |
| Which NPC sells which item, price, units per purchase, limited stock flag, map position | O2 | EG Link output on GitHub, recorded by players' addons when they open vendor windows in Forever, committed daily, 13 live builds | **Obtainable, inspected.** Nerrist in Stranglethorn sells Bright Baubles at 2s 50c Friendly and 2s 25c Honored, one per purchase, unlimited. Coverage is partial, about 361 vendors so far against 856 in Classic, and grows daily. Licence CC BY 4.0, so the tool must credit it |
| Price depends on reputation | O2 | Same file, priced per standing | **Obtainable.** The tool needs Chip's standing with each vendor's faction, or assumes the worst listed price |
| Vendor faction | O2 | Waypoint tracker and AllTheThings data on GitHub | **Obtainable.** Needs a join |
| Restock timer for limited items | O2 | cMaNGOS Classic database | **Provisional, Classic only.** Forever data has the limited flag but no timer |
| Vendors no player has recorded yet | O2 | Questie Forever data maps NPCs to items with positions but no prices | **Provisional, Classic data with Forever coordinates** |
| Bartering legacy perk, 10 percent off vendor prices | O2 | Chip's own account | **Missing.** Chip enters it |
| Mister Graphed fixed prices in Powderfuse Port | Ceilings | A guide site says he sells top reagents at 5g, 20g and 50g | **Provisional and now conflicting.** He appears in no player vendor recording. He may be a trade or turn in NPC rather than a gold vendor. Our strategy doc treats his prices as verified ceilings. That claim is downgraded until Chip or a second source confirms it |

### 9.4 Recipe data

| Need | Used by | Source | Status |
| --- | --- | --- | --- |
| Every recipe, its reagents, its product and output quantity | O4 | Blizzard profession and recipe endpoints | **Verified.** 13 professions, 507 in Blacksmithing alone |
| Skill to learn, and the yellow, green and grey thresholds | O4, skill cost per point | SkillScribe on GitHub, generated from Wowhead's Forever database, 2,130 recipes, updated November 17 | **Obtainable, inspected.** Rough Sharpening Stone reads learn at 1, yellow 15, green 35, grey 55. A second independent planner agrees. Secondhand, not from the game files |
| How each recipe is learned and what it costs | O4 | SkillScribe sources (starter, trainer with cost, vendor recipe with price, drop), EG Link trainer data | **Obtainable.** Trainer costs cross check against player recorded trainer windows |
| Linking a Blizzard recipe to its threshold row | O4 | Join on crafted item | **Obtainable with a caveat.** Blizzard does not expose spell ids. Two recipes that make the same item need a tiebreak on reagents |
| Game file thresholds as a primary source | O4 | wago.tools tables for the Forever client | **Provisional.** The tables exist, but automated download is blocked. A person in a browser can probably export them. Only worth doing if SkillScribe proves wrong |
| Chip's professions, skill and known recipes | O4 filters | Blizzard profile endpoint for his character | **Provisional.** Community reports it works for Forever characters level 10 and up after logging out. Chip can type them in as a fallback |

### 9.5 Auction house rules

| Need | Used by | Source | Status |
| --- | --- | --- | --- |
| Cut on a sale | All net math | Guide site says 5 percent at faction houses, 15 percent at neutral houses | **Provisional.** One real sale settles it |
| Deposit and listing floor | All net math | Conflicting. The November 10 hotfix line was pulled, players report the 1 copper deposit arrived November 18, and some report a 1 silver minimum listing price remains | **Provisional and important.** If a 1 silver listing floor exists, O1 style dumps below 1 silver cannot exist and cheap items cannot be resold at all. One test listing settles it |
| Durations, sale payment delay | Effort estimates | Guide site and patch notes. 2, 8, 24 hours. Gold arrives by mail an hour after sale | **Provisional** |

### 9.6 Gathering and farming

| Need | Used by | Source | Status |
| --- | --- | --- | --- |
| Gold per hour for any activity | O5 | Chip's own logged sessions | **Missing by nature.** No Forever drop or spawn rate data exists anywhere. Only measurement works |
| Node locations | Planning only | Questie Forever object data | **Provisional, Classic positions on Forever maps.** Nothing for new Forever zones |

### 9.7 What this means for the detectors

| Detector | Ready on | Weakest link |
| --- | --- | --- |
| O1 Vendor dump | Verified data only | The listing floor question in 9.5 |
| O6 Sell now | Verified data plus a week of history | History |
| O4 Craft margin | Verified recipes plus obtainable thresholds | Binding and Chip's known recipes |
| O3 Underpriced flip | Verified data plus history | History, then sell through estimates |
| O2 Vendor supply | Obtainable vendor data | Coverage, reputation pricing |
| O5 Farm log | Nothing external | Chip's discipline logging sessions |

## 10. Releases, in build order

Ordered by effort and value. Each release is usable on its own.

| Release | What Chip gets | Depends on | Size |
| --- | --- | --- | --- |
| R1 | Collector on his house, item lookup, O1 vendor dump feed | Verified data only | one session |
| R2 | Phone and desktop alerts, profile filters, watchlist, O6 | R1 | one session |
| R3 | O4 craft board | Recipe skill data | one to two sessions |
| R4 | O3 underpriced listings, sell through estimates | A few days of R1 history | one session |
| R5 | O2 vendor supply with verified vendors and candidates | Vendor dataset | one to two sessions |
| R6 | O5 farm log | Nothing external | one session |

R1 starts collecting history the day it runs, which is why it goes first even though O1 alone is the smallest prize.

## 11. What Chip has to do

Ordered by effort, smallest first. Steps 1 to 4 are in game and take about ten minutes together. Nothing here is a download. The vendor and recipe data live in public GitHub repositories, and the tool fetches and refreshes them itself every day, so Chip never handles a database by hand.

1. **Done.** Blizzard API client created, credentials working, verified November 17.
2. **Pin the house, two minutes.** Open the auction house, search Copper Ore and Linen Cloth, read the lowest price per unit for each. The candidates as of November 18 were house 110 at 1s 50c and 22c, house 111 at 84c and 24c, house 119 at 82c and 25c, house 123 at 96c and 25c. Prices move, so a fresh pull goes alongside the check.
3. **Settle the listing rules, three minutes.** List one cheap item for 2 hours. Note the deposit charged. Try to list something below 1 silver and note whether the game allows it. When anything sells, compare the mailed gold to the sale price to read the real cut.
4. **Record the discounts, one minute.** Note his standing with Booty Bay and any other vendor faction he uses, and whether his account has the Bartering legacy perk.
5. **Pick the alert channel, five minutes.** See open decision 1. If Discord, make a private server with one channel and create a webhook in its settings.
6. **Log out once on the character,** if the profile endpoint is going to read his professions automatically. Characters only appear after a logout.
7. **Keep the PC on while he wants alerts.** The collector runs on his machine, so alerts stop when it sleeps. If that becomes a problem, moving it to a small always on host is a later decision, not a phase 1 one.
8. **Hand this doc to Claude Code** with the API runbook and the verification ledger. Claude Code designs the build. This doc is the requirement.

**Optional, only if the recipe thresholds prove wrong.** In a normal browser, open wago.tools, go to the SkillLineAbility table, choose a 1.60.1 Forever build in the build selector, and use the CSV download. That gives thresholds straight from the game files instead of secondhand.

## 11a. Data upkeep the tool owns

1. **Auction snapshots** for Chip's house, every publish, without fail.
2. **Vendor and recipe datasets** refreshed from their GitHub sources once a day, with the dataset version shown in settings.
3. **Vendor sell prices** for every item seen, refreshed once a day. A changed sell price is surfaced as news on the feed, because a hotfix that changes vendor payouts creates or kills O1 plays overnight.
4. **Credits screen** naming EG Link and any other licensed source, as their licences require.
5. **A data health line** at the top of the feed whenever anything above is stale, late or failing.

## 12. Out of scope for phase 1

1. Anything inside the game client. The tool never clicks, buys, lists or reads his bags. He acts, the tool advises.
2. Seller identity. Blizzard does not publish it.
3. Other factions, other rulesets, Hardcore.
4. Phase 2 raid consumable planning, beyond the craft board's everyone view.

## 13. Open decisions for Chip

(Filled after review.)
