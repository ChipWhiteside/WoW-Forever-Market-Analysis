# WoW Forever Gold Finder, Product Spec

Version 3, November 18, 2026. Product lead document. It defines what the tool does, how it behaves, how it looks, how fast it must be, what data it runs on and when each piece ships. How to build it belongs to Claude Code. Where this doc and the older app spec disagree, this doc wins.

## 1. What Chip asked for

1. **Gold now, in phase 1.** The market is early and chaotic, so mispricings appear constantly and close within hours. The tool exists to find them on purpose instead of by accident.
2. **The edge is information and timing.** Bright Baubles worked because Chip saw a vendor item selling at twice its vendor price at the right moment, and the gap was gone by the next morning.
3. **Every way to make gold, visible in one organized place.** Vendor dumps, vendor supply, underpriced listings, buying on one house to sell on the other, crafting, gathering, and gear that drops in the world or in dungeons.
4. **Crafting with the cheapest ingredients.** For any recipe, find the cheapest way to get every ingredient, whether bought on an auction house, bought from a vendor, crafted from its own ingredients, or gathered himself, usually a mix, and show whether crafting and selling the result makes money.
5. **World and dungeon loot in its own section.** Item, drop rate, which enemy, boss or event drops it, auction and vendor prices, and an estimated gold per hour of farming it.
6. **Per item, he wants** the lowest price, units at each price, ladder depth, data age, what a vendor pays, what a vendor charges and where, which recipes make it and their cost, and which recipes use it.
7. **The tool finds, Chip decides.** It alerts him to opportunities and explains them. He decides in the moment how much to buy and invest. Insight about why a quantity matters is welcome, instructions on quantity are not.
8. **Alerts on the hour, only when there is something.** Vendor dumps, vendor supply, underpriced listings and resale plays. An hour with nothing worth his time sends nothing.
9. **Automatic where possible.** Purchases, gold and profession progress should flow in without manual reporting wherever the game allows it.
10. **Clean and readable at a glance,** with a light touch of WoW Forever flavor on top.
11. **Desktop first, website later.** It runs on his PC now, on demand or on a schedule. Later it lives on his own website so his brothers can use it, which brings more data and more feedback.
12. **Phase 2 starts December 9,** when raids open and players reach 60, and shifts toward crafting and professions. Phase 1 must not block it.

## 2. The experience

The tool runs on Chip's PC. Each hour Blizzard publishes a fresh snapshot of each of his two auction houses, the Alliance house and the neutral Blackwater house. Within minutes of each publish the tool has read every listing and checked every item against vendor prices, recipe trees, drop data and recent history. If anything new clears his profit bar, his phone gets one message listing the new plays, one line each. He opens the tool when he wants detail, finds every gold making method in its own section, decides what to do, and does it in game. What he buys and earns flows back into the tool on his next logout or reload once the companion addon ships.

## 3. The auction houses Chip can reach

Three separate systems, as reported by Chip's research with guide sources, with the first two also confirmed by our own calls and his own sales.

1. **The Alliance house,** 5 percent cut, verified from his own sales. Stormwind, Ironforge, Darnassus and Zelena Favorbreeze in Valanaar on Zephras Isle all reach the same market. Valanaar is a neutral town, but its auctioneer routes Alliance players into the Alliance house.
2. **The Blackwater house,** neutral and cross faction, 15 percent cut, verified from his own sales. Booty Bay, Gadgetzan and Everlook. Guides report deposits five times higher than the Alliance house.
3. **The Black Market in Powderfuse Port,** run by NPCs, with no player listings. Madam Swyndle runs blind bids on rotating rare items. Mister Graphed is reported beside her selling rare crafting materials at fixed prices.

The tool reads houses 1 and 2. Once Chip records Mister Graphed's prices in game, the tool treats them as price ceilings for those materials and as a buy source in the make or buy tree. Until then it ignores them. Blind bids are out of scope in phase 1.

## 4. The timing ceiling, stated plainly

Blizzard publishes each house about once an hour, confirmed with our own polling on November 18. The freshest data the tool can ever show is the latest hourly snapshot, so its job is to act within minutes of each publish. Inside the hour, only an in game Auctionator scan sees changes, and that stays Chip's manual check before a large buy.

**When the tool was not running.** Blizzard only ever serves the current snapshot, so any hour the tool misses is lost from history permanently. When the tool starts after a gap, it shows the gap on the health line, it stretches the history windows backward until they hold enough readings, and it never sends alerts for plays found in old data.

## 5. Opportunity types

Every detector follows the binding data rules in the market doc, which use the lowest listed price only, always show ladder depth, and give every number its age and its house.

**Typical floor,** used by O3 and O6, is the middle value of the hourly floors over the last 72 hours, and exists only after 24 hourly readings. It is a statistic of the floor over time, not a median of listing prices, which the data rules ban as a selling signal.

**What every play shows instead of a quantity.** The profit available, defined per detector below, and the ladder. Where the shape of the ladder matters, the play says why in plain words, for example "depth is thin above the floor, so a large listing becomes the new floor". It never tells Chip how many to buy.

### O1. Vendor dump

**Question.** Is anything listed below what a vendor pays for it?
**Rule.** A listing whose unit price is below the item's vendor sell price.
**Play.** Buy under the line, sell to any vendor.
**Profit available.** For every listing under the line, the vendor price minus the listing price, added up.
**Risk.** Very low, because it is arithmetic on verified data and any vendor buys at the sell price. The real risk is an hour old listing being bought before he arrives.
**Note.** Players report a minimum listing price of 1 silver. If true, O1 only finds items that vendor for more than 1 silver.

### O2. Vendor supply

**Question.** Is a vendor item listed well above the vendor's price?
**Rule.** The floor, after the selling house's cut and deposit, exceeds the vendor's price at Chip's standing.
**Play.** Buy from the named vendor, list on whichever house nets more.
**Profit available.** The net gain per unit at the current floor, times the units that sell through in a typical day once history exists. Before history exists, the play shows the gain per unit and says demand is not yet known.
**Risk.** Medium, because the floor can move during the trip.
**Scope.** Vendors recorded in Forever by players, filtered to vendors an Alliance character can use, priced at Chip's standing or at the worst listed price when unknown. Bright Baubles is the acceptance case. Nerrist is Horde and must never appear for Chip. Old Man Heming on the Booty Bay docks, Edna Mullby in Stormwind and Christopher Hewen in Westfall all sell it.
**Trip time.** Shown from recorded flight routes, measured from the home city Chip sets, so the play reads "about 4 minutes by flight from Stormwind".

### O3. Underpriced listing

**Question.** Is something listed far below its typical floor, on an item that actually sells?
**Rule.** The floor sits at least 30 percent under the typical floor, and at least three listings priced within 10 percent of the typical floor disappeared before expiring in the last 72 hours.
**Play.** Buy the cheap units, relist near the typical floor.
**Profit available.** For every cheap listing, the typical floor after the cut minus its price, added up.
**Risk.** Medium, because resale demand is inferred.
**Cold start.** Shows "learning, N of 24 hours collected" until the typical floor exists.

### O4. Crafting, make or buy

**Question.** For any recipe, what is the cheapest way to get every ingredient, and does crafting and selling the product make money?

**The tree.** Every product breaks down into its ingredients, and every ingredient that can itself be crafted breaks down again, all the way to raw materials. At every node the tool weighs four ways to get it.

1. Buy it on the Alliance house or the Blackwater house.
2. Buy it from a Forever recorded vendor at Chip's standing, or from Mister Graphed once his prices are recorded.
3. Craft it from its own ingredients, if Chip has the skill.
4. Gather it himself.

**Valuing what he gathers.** Three settings, chosen per recipe or globally. The default is what he could have sold it for on the auction house, so crafting from his own ore only wins when it beats selling the ore. If the item has no listing, its vendor sell price stands in. The second option treats it as free. The third prices it by his own time, using his measured items per hour from the Farming section and a gold per hour value he sets for his time.

**Edge cases, each with a stated behavior.**

1. An ingredient no house, vendor or recipe provides, such as a drop, shows "no source, path blocked" and names where it drops if known.
2. A recipe that sometimes makes extra items is valued at its expected output, labeled as expected.
3. Crafts with a cooldown show the cooldown beside the margin.
4. Recipes Chip does not know yet show the cost to learn them and where.

**What Chip sees.** The cheapest path through the tree with the choice made at each node, the margin against the product's floor after the cut, and the next best path for comparison.

**Profit available.** Margin per craft times the product's typical daily sell through once history exists, otherwise the margin per craft alone.

**Intermediates are products too.** If smelting ore into bars, or turning stone into sharpening stones, sells for more than the inputs, that is a play on its own.

**Gates.** Bind on pickup products are never shown as sales.

**Leveling view.** A craft that loses a little but grants a skill point is shown as gold per expected skill point. The odds come from the recipe's difficulty color at his current skill, with orange certain, yellow likely and green unlikely, labeled as approximate.

**Scope in phase 1.** Chip's own professions, plus a read only everyone view of every other profession as the phase 2 shopping list.

### O5. Gathering and farming return

**Question.** What is an hour of an activity worth right now?
**Rule.** Chip's own timed sessions, items per hour times current net value. Never modeled, because no Forever spawn data exists for gathering nodes.
**Play.** Start a session, play, end it. Once the companion addon ships, what he gathered fills in by itself.

### O6. Sell now

**Question.** Has something Chip holds jumped in price?
**Rule.** For anything in his positions or watchlist, the floor sits at least 50 percent above its typical floor on either house, or crosses a price he set.
**Play.** List into it, on whichever house nets more after its cut.
**Profit available.** His held units times the difference between the current net price and what he paid.

### O7. Cross house flip

**Question.** Is an item cheaper on one of Chip's two houses than the other, by more than the selling house takes?
**Rule.** The selling house's floor, minus its cut and deposit, exceeds the price on the buying house. Because Blackwater keeps 15 percent, its floor must sit roughly 18 percent above the Alliance price to break even, and the Alliance house needs roughly 5 percent going the other way.
**Play.** Buy on one house, carry the goods, list on the other.
**Profit available.** For every buy side listing under break even, the net sale price minus its price, added up.
**Risk.** Medium, because both floors move during the trip.

### O8. World drops and dungeon loot

**Question.** Which sources drop things worth farming, and what is that worth per hour?

**Source types.** Normal enemy, elite enemy, rare spawn, dungeon boss, dungeon trash, world drop pool, gathering node, fishing, container and event. Each source carries its type, and the section filters by it.

**Two views.**

1. **By item.** Icon, name in its quality color, every source that drops it, drop chance per kill, bind status, floor on both houses, vendor sell price.
2. **By source.** Each source with its zone, level, solo or group, and value per kill, which adds up every sellable drop it gives, times its chance, times its net value. Farming happens by source, not by item, so this view answers where to spend an hour.

**Drop rates, honestly labeled.** Forever rates come from player recorded kills, and every rate shows how many kills it rests on and how many players recorded them. Below 50 kills the rate is flagged rough. Where Forever has too few kills, the Classic rate appears instead, clearly marked as Classic. World drop pools, the gear any enemy in a level band can drop, appear as "any enemy level 20 to 25", labeled Classic, because no Forever recording expresses them. New Forever content with no Classic equivalent, such as Hall of Thanes, Ruins of Lordaeron, Drowned City and the new rares, shows only what players have recorded.

**Random suffix gear.** Items that come in variants such as "of the Bear" share one name but sell at different prices. They are priced by the actual variant where the listing shows it, and otherwise flagged with their price spread.

**Gold per hour.** Value per kill times kills per hour. Kills per hour is measured from Chip's own timed sessions on that source wherever they exist. Otherwise it uses a stated assumption that Chip can edit, labeled estimated, with defaults of 60 kills an hour for normal enemies, 20 for elites, and one run an hour for a dungeon. Measured always replaces estimated once he has timed it. Rares show their known respawn timer and value per kill instead of gold per hour.

**Filters.** Level range he can reach, source type, solo or group, sellable only.

## 6. Ranking and confidence

1. **Net only.** Sale side minus that house's cut, minus deposit, minus buy cost. Each play names the house it assumes and, until the deposit rules are confirmed, the deposit it assumed.
2. **Ranked by profit available,** as each detector defines it, with effort and trip time shown alongside.
3. **Confidence on every play.** High is arithmetic on verified data. Medium depends on resale. Low rests on unconfirmed data, such as an unknown standing, a recipe with no threshold row, or a drop rate under 50 kills.
4. **Expiry.** A play is live until a newer snapshot shows the gap closed, then it is marked gone and stays visible for 24 hours.
5. **Outliers.** A single listing far below the rest counts and is flagged as a possible one off.
6. **Profit bar.** Minimum profit available for an alert, default 25 silver.

## 7. Sections

Every gold making method lives in its own section, reached from a persistent section list down the left side. The UI designer owns the final layout. These are the sections and the one question each answers.

| Section | Answers at a glance |
| --- | --- |
| **Now** | What is new and live this hour, best first, each linking into its own section |
| **Vendor plays** | O1 and O2, with vendor names, positions and trip times |
| **Resale** | O3 and O7, with typical floor and the gap |
| **Crafting** | O4, the make or buy board for his professions, plus the everyone view |
| **World drops** | O8, by item and by source |
| **Farming** | O5, gold per hour per activity, session history |
| **Positions** | What he bought, what it cost, what it is worth now, what sold |
| **Market** | The weekly market read from the bot report spec |
| **Watchlist** | Pinned items with his price alerts |
| **Item lookup** | Search anything, see everything known about it |
| **Settings** | Character, houses, home city, standings, starting gold, profit bar, alerts, data versions, credits |

**The play view,** opened from any section, reads as a short explanation rather than an instruction. For example, "34 Linen Cloth are listed below the 13c vendor price on the Alliance house, and taking all of them would clear about 1s 2c. Data 6 minutes old, confidence high." Below it sit the ladder, a week of floor history, vendor or source details, and done, skipped and already gone buttons.

**Item lookup** shows floor and ladder on both houses, typical floor, history, vendor sell price, Forever recorded vendors with faction and price, the make or buy tree for anything craftable, recipes that use it, and every source that drops it. Unnamed items show their id and never disappear.

**Market** covers every item in the bot report spec in the money patterns doc. Whole market aggregates, category share by item class, three rankings by minimum price with at least 5 units and by value and by units, the top 150 by value with week over week floor change beside units change, units within 5 percent of the floor, seven day change, and the bag table by slot size. It flags saturation, first movers and round number floors from the analyst's lens. Movers appear once seven days of history exist.

## 8. Alerts

1. **On the hour, per house, only when there is something.** Within five minutes of each house's publish, the tool sends one message listing every new play from that house that clears the profit bar, best first, one line each. Plays from both houses arriving within the same few minutes share one message. If nothing new qualifies, nothing is sent.
2. **Which plays alert.** Vendor dump, vendor supply, underpriced listing and cross house flip. Crafting, world drops, farming and sell now appear in the tool without alerting, and each can be switched on in settings.
3. **To his phone, wherever he is,** and to the desktop. Each line carries enough to act on without opening the tool.
4. **No repeats** for a play already sent unless its profit available grows by at least 25 percent. Quiet hours default to 11pm to 7am his time.

Example of one message.

> 3 new plays this hour.
> Vendor dump, Linen Cloth, 34 under the 13c vendor price, up to 1s 2c.
> Vendor supply, Bright Baubles, Old Man Heming 2s 50c, Alliance floor 4s 80c, about 2s 6c each after the cut.
> Cross house, Wool Cloth, about 31c each after the Blackwater cut.

## 9. What fills in automatically

Chip asked whether purchases, gold and profession progress can come in without manual reporting. The answer depends on the source, and the tool uses the best one available for each.

| Information | Automatic source | Status | Fallback |
| --- | --- | --- | --- |
| Professions and skill | Blizzard character data | **Provisional.** Community reports it works for Forever. Test T8 | Typed in settings |
| Known recipes | Blizzard character data, then the companion addon | **Provisional.** Test T8 | Every recipe at or under his skill treated as learnable, with its cost to learn shown |
| Reputation standings | Blizzard character data | **Provisional.** Test T8 | Typed in settings |
| Gold on the character | Blizzard's protected character data, which needs Chip's own Battle.net login | **Untested.** It returns forbidden for Classic characters. Test T10 | Starting gold typed in settings, then adjusted by positions |
| Bags, purchases, sales, auction mail | No Blizzard source exists | **Only through a companion addon** | The done button on each play |

**The companion addon.** A small addon of Chip's own that records what he buys, sells, receives by mail, carries, earns and knows, and leaves it in the file the game saves for addons. The tool reads that file. The game only writes it when he logs out or types /reload, so positions and gold are current as of his last reload, never live to the second. The addon only records and never buys, lists, clicks or automates anything. Recording addons such as Auctionator already do this, and Blizzard's addon policy forbids automation rather than recording, but that policy is not yet checked against Forever, so this stays provisional until test T14. Until the addon ships, the done button on each play opens a position with the quantity and price prefilled for him to adjust.

## 10. Look and feel

1. **Not a dark trading terminal.** Stylized, clean and sleek, so each screen answers its one question at a single glance before the eye has to hunt. Generous spacing, a clear hierarchy, and very few colors doing real work.
2. **A light layer of WoW Forever on top.** Item names in their in game quality colors, real item icons, gold, silver and copper coin icons on every price, and a restrained warm accent that nods to the game. Any fantasy styling stays in headers and small touches, never in the numbers. Where an icon or name is missing, a plain placeholder with the item id takes its place.
3. **The profit number leads** every play and every row.
4. **Plain verbs** such as buy, vendor, list, craft, farm and go.
5. **Uncertainty stays visible.** Confidence, data age, house, and for drop rates the kill count are always shown and never buried.
6. **Phone view** in phase 1 is the alert message itself. The full tool lives on the PC until the website version exists.

## 11. Speed and reliability targets

| Moment | Target |
| --- | --- |
| A house publishes, to its plays in the tool | under 3 minutes |
| A house publishes, to its alert message | under 5 minutes |
| Any section, the play view or item lookup opens | under 2 seconds |
| Make or buy tree for any recipe | under 2 seconds |
| Crafting board for his professions | under 5 seconds |
| Addon data in the tool after a logout or reload | under 1 minute |
| Snapshots missed while the tool is running | zero |
| History kept | every hourly floor and ladder summary, permanently |

A late or missing snapshot shows on a health line at the top of Now, and plays built on it are marked stale.

## 12. Data inventory

Researched and tested November 18 by three independent agents, with key rows checked by hand. **Verified** means we pulled and inspected it ourselves. **Obtainable** means the source is located and a sample inspected but not wired in. **Provisional** means secondhand, Classic fallback, conflicting or untested. **Missing** means no source exists, so the tool or Chip creates it.

### 12.1 Market

| Need | Source | Status |
| --- | --- | --- |
| Floor, units per price, totals, listing counts for stackables | Blizzard auction data per house, already priced per unit | **Verified** |
| Same for equipment | Blizzard auction data per house, every listing a single item | **Verified** |
| Refresh rhythm | Blizzard's last updated time on each house, about hourly, held 52 minutes in our test | **Verified** |
| Which two houses are Chip's | Chip, once, in game. Alliance candidates 110, 111, 119, 123. Blackwater candidates 116, 117, 121, 125 | **Missing,** blocks every number |
| Price history | The tool's own archive | **Missing until R1 runs.** No per house history exists anywhere, so the archive is the moat |
| Sell through | Inferred from listings that disappear between snapshots | **Provisional by nature,** since a disappearance may be a sale, a cancellation or an expiry |
| Number of sellers | None | **Not available.** Blizzard does not publish seller identity |

### 12.2 Items

| Need | Source | Status |
| --- | --- | --- |
| Names | Blizzard item data, Forever version | **Provisional.** Our top 20 resolved 20 of 20, a community survey found about 43 percent unnamed. Test T2 |
| Quality, class, required level | Blizzard item data | **Provisional** until seen in a Forever response |
| Item icons | Blizzard item media | **Provisional.** Test T11 |
| What a vendor pays | Blizzard item data | **Verified,** refreshed daily because hotfixes change it |
| Binds on pickup or equip | Blizzard item data | **Provisional.** Test T1 |
| Maximum stack size | Not published | **Provisional.** Largest stack seen listed is a lower bound |

### 12.3 Vendors and travel

| Need | Source | Status |
| --- | --- | --- |
| NPC, item, price by standing, units per purchase, limited flag, position | EG Link output on GitHub, recorded by players' addons in Forever, published daily | **Obtainable, inspected.** 361 vendors so far against 856 in Classic, growing daily, thin in places. License CC BY 4.0, credit required |
| Vendor faction | Waypoint tracker and AllTheThings data on GitHub | **Obtainable but fragile.** A naive match returned wrong lines for some vendor ids. Test T4 |
| Flight routes and times | EG Link flight recordings | **Obtainable,** not yet inspected in detail. Test T15 |
| Restock timers | cMaNGOS Classic database | **Provisional,** deferred to phase 2 |
| Bartering perk, standings | Character data or Chip | **Provisional,** see section 9 |
| Mister Graphed fixed prices | Two guide sources and a video place him beside Madam Swyndle selling rare materials at fixed prices | **Reported, not seen by us.** No price list exists in any source we found. Chip records it in game. Test T13 |

### 12.4 Recipes

| Need | Source | Status |
| --- | --- | --- |
| Recipes, ingredients, product, output quantity | Blizzard profession and recipe data | **Verified.** 507 Blacksmithing recipes |
| Learn skill, yellow, green and grey thresholds, how learned, trainer cost | SkillScribe on GitHub, from Wowhead's Forever database, 2,130 recipes, plus EG Link trainer recordings | **Obtainable, inspected.** Rough Sharpening Stone reads 1, 15, 35, 55, and a second planner agrees. About 428 Blacksmithing rows against Blizzard's 507. Test T3 |
| Crafting cooldowns and extra output chances | SkillScribe output ranges, Classic data for cooldowns | **Provisional** |
| Chip's professions, skill, known recipes | Character data, then companion addon | **Provisional,** see section 9 |

### 12.5 Loot and farming

| Need | Source | Status |
| --- | --- | --- |
| Drop chance per kill in Forever, with kill counts and contributors | EG Link loot recordings on GitHub, per build, covering corpse loot, skinning, pickpocketing and boss rolls | **Obtainable, inspected.** 15,127 recorded kills across 2,758 loot sources. Thin, with most sources under 10 kills and about 22 above 50. Grows daily |
| Drop chance, Classic fallback, including world drop pools | cMaNGOS loot tables and pfQuest percentages | **Provisional, Classic.** Labeled wherever shown |
| Source level, zone, rare or elite | EG Link creature recordings | **Obtainable** |
| Loot for new Forever dungeons, zones and rares | Player recordings only | **Thin.** No Classic fallback exists for this content |
| Rare respawn timers | A few patched Forever timers, the rest Classic | **Provisional** |
| Normal respawn timers, dungeon clear times, kills per hour | None published | **Missing.** Estimated by stated defaults, replaced by Chip's timed sessions |
| Gold per hour for gathering | Chip's timed sessions | **Missing by nature** |

### 12.6 Auction house rules

| Need | Source | Status |
| --- | --- | --- |
| Cut | Chip's own sales, November 15 | **Verified.** 5 percent Alliance, 15 percent Blackwater |
| Deposit kept on expiry | Chip's mailbox, November 15 | **Verified** |
| Deposit amount and minimum listing price | Reports say the minimum deposit fell to 1 copper on November 18, the Classic deposit formula still applies above that, Blackwater charges five times as much, and a 1 silver minimum listing price may remain | **Provisional.** Test T7 |
| Durations and payment delay | Guides and patch notes, 2, 8 and 24 hours, gold mailed an hour after sale | **Provisional** |

## 13. Tests

Each test either blocks its release or falls back, as listed.

| Test | Pass bar | If it fails |
| --- | --- | --- |
| T1 Binding | Five known bind on pickup and five bind on equip items show correctly from Forever data | Blocks R4 and R5 |
| T2 Names | At least 95 percent of distinct items on Chip's houses named after fallbacks, rate recorded | Falls back to id placeholders, R1 ships |
| T3 Recipe thresholds | Every recipe Chip can learn in Blacksmithing and Mining maps to exactly one threshold row, with unmatched ones listed rather than dropped | Blocks R4 |
| T4 Vendor faction | Bright Baubles resolves to Old Man Heming, Edna Mullby and Christopher Hewen among Alliance usable sellers, Nerrist excluded, no ambiguous matches | Blocks R3 |
| T5 Vendor pricing | The modeled Bright Baubles price at Chip's standing matches what he actually paid | Blocks R3 |
| T6 Ladder | Copper Ore ladder in the tool matches the in game window in the same hour, on both houses | Blocks R1 |
| T7 Listing rules | A test listing on each house confirms the deposit and whether anything lists under 1 silver | Falls back to the assumption in decision 4 |
| T8 Character data | Returns Chip's Blacksmithing and Mining skill, known recipes and Booty Bay standing | Falls back to typed settings |
| T9 Loot coverage | Report how many sources in levels 15 to 35 have at least 50 recorded kills | Never blocks, it sets expectations shown in the section |
| T10 Gold | With Chip's own Battle.net login, protected character data returns gold for his Forever character | Falls back to typed starting gold plus positions |
| T11 Icons | Item media returns icons for Forever items, including a Forever only item | Falls back to placeholders |
| T12 Addon round trip | After a logout, the tool shows a purchase made in game and the new gold total within a minute | Blocks R7 |
| T13 Mister Graphed | Chip records his item list and prices in game | Until done, he is ignored |
| T14 Addon events and policy | Forever's addon interface exposes purchase, sale, mail and gold changes, and Blizzard's addon policy permits recording them | Blocks R7 |
| T15 Flight data | Flight times between Stormwind and Booty Bay in the recordings match the in game flight within a minute | Falls back to zone names with no time |

## 14. Releases

Raids open December 9 and end phase 1. Dates are targets. **Prerequisite for R1, due November 20.** Chip pins both houses in game. If anything slips, the companion addon goes first, then Market, then the by source view of world drops, and the order of everything else holds.

| Release | Target | What Chip gets | Done when |
| --- | --- | --- | --- |
| R1 | Nov 21 | Capture of both houses, item lookup, O1 vendor dump, Now with health line | 24 hours captured on both houses with no gaps while running. T6 passes. Plays appear within 3 minutes of each publish. Lookup opens in under 2 seconds. Stopping the tool for an hour shows the gap on the health line and sends no stale alerts on restart |
| R2 | Nov 24 | Alert messages, positions with the done button, settings with starting gold, watchlist, farming timer | A message reaches his phone away from home within 5 minutes of a publish, and an hour with no new plays sends nothing. Done on a play opens a position and available gold falls from the typed starting gold by the amount paid. A timed session of 20 Copper Ore in 10 minutes shows 120 an hour priced at the current floor |
| R3 | Nov 27 | O2 vendor supply, O7 cross house flip, trip times | T4, T5 and T15 pass. Bright Baubles shows only Alliance usable sellers with trip times from Stormwind. An item whose Blackwater floor clears the Alliance price by more than the break even appears with its net gain |
| R4 | Dec 1 | O4 make or buy crafting for his professions, intermediates as plays, gold per expected skill point, everyone view | T1 and T3 pass. Copper Bar shows buy the bar, buy ore and smelt, and use his own ore, with the cheapest highlighted and the margin matching a hand calculation from the same floors. A blocked ingredient shows "no source". No bind on pickup product appears as a sale |
| R5 | Dec 3 | O8 world drops by item and by source | T1 passes and T9 is reported. Every rate shows its kill count and origin. Value per kill for Rabid Dire Wolf matches a hand calculation from its recorded drops and current floors. Gold per hour is labeled measured or estimated |
| R6 | Dec 6 | O3 underpriced listings, O6 sell now, Market section | With 72 hours of history, a listing 40 percent under a typical floor that meets the disappearance rule appears as an O3 play. A held position whose floor jumps 50 percent appears as sell now. Market shows every report spec item |
| L1 | Nov 25 | The overnight improvement loop, section 21 | A deliberately planted bug is found by the auditor, fixed, passes testing and review, goes live and appears in the changelog. A planted problem that cannot be fixed is reverted after three rounds and flagged for Chip. A run that starts at 10am exits without doing any work. Usage for the night appears in the changelog |
| R7 | After Dec 9 | Companion addon feeding positions, gold, bags, sales and known recipes | T12 and T14 pass. Positions open and close themselves from real purchases and sales |
| R8 | After phase 1 | Website version for his brothers | A second person signs in, picks his own houses, sees his own plays, and cannot see Chip's positions or gold. See section 15 |

R1 goes first because history starts the day it runs and three detectors depend on it. World drops comes before resale because it needs no history.

## 15. The website version

Phase 1 is a desktop tool. These requirements keep the later move to Chip's website a deployment step rather than a redesign.

1. **Every setting, position and session belongs to a person,** even while Chip is the only one.
2. **Calls to Blizzard grow with houses, not people.** Two brothers on Chip's houses add nothing. A brother on another ruleset or the Horde adds his houses once.
3. **Each person picks their own character, faction, ruleset and houses,** and sees only plays for their own houses.
4. **Market, vendor, recipe and loot data are shared.** Positions, gold and settings are private to each person.
5. **Farm sessions and kill counts can be pooled** if each person opts in. More players timing the same source turns estimated gold per hour into measured gold per hour faster, which is the main payoff of letting his brothers in.
6. **Each person's companion addon data reaches the website automatically** from their own PC.
7. **Sign in with Battle.net,** which also unlocks protected character data where Blizzard allows it.
8. **Credits page** for every licensed data source, and nothing that resells Blizzard data.

## 16. What Chip has to do

Ordered by effort. Steps 2 to 4 are in game and take about ten minutes together. Vendor, recipe and loot data come from public GitHub repositories the tool fetches and refreshes daily, so nothing here is a download.

1. **Done.** API credentials created and working, November 17.
2. **Pin both houses by November 20, four minutes.** At a capital auction house, search Copper Ore and Linen Cloth and read the lowest price per unit. Do the same at the Booty Bay auction house. A fresh pull of every candidate house accompanies the check.
3. **Settle the listing rules, three minutes.** List one cheap item for 2 hours on each house and note the deposit. Try listing something under 1 silver.
4. **Record discounts and the Baubles source, one minute.** Booty Bay and Stormwind standing, the Bartering perk, and which vendor sold him the 40 Bright Baubles and at what price.
5. **Set his home city and starting gold** in settings.
6. **Give the tool his character's name and surname,** which is how Forever identifies characters, and log out once.
7. **Pick the alert channel, five minutes.** Decision 1 below.
8. **Record Mister Graphed's list and prices** the first time he passes through Powderfuse Port.
9. **Optional and helpful.** Install the EG Link addon. Every vendor he opens and enemy he kills gets recorded into the same public data the tool uses, which thickens drop rates in his own level band.
10. **Install the companion addon** when R7 ships.
11. **Turn off usage credits** in Settings, under Usage, if they are on, so the overnight loop can never spend past his plan.
12. **Leave the Claude desktop app open overnight** with Keep computer awake turned on, so the loop's nightly run is not skipped.
13. **Read the changelog** when he gets on each morning.
14. **Keep the tool running while he wants alerts,** on a schedule or left open, until the website version exists.
15. **Ask his brothers** which faction and ruleset they play, before R8.
16. **Hand this doc to Claude Code** with the API runbook and the verification ledger.

## 17. Data upkeep the tool owns

1. Capture every snapshot for both houses while running.
2. Refresh vendor, recipe and loot datasets daily, and show their versions in settings.
3. Refresh vendor sell prices daily, and surface any change as news in Now, because a hotfix to vendor payouts creates or kills plays overnight.
4. Show credits for EG Link and every other licensed source.
5. Keep the health line honest.

## 18. Out of scope for phase 1

1. **Any automation inside the game.** The tool and the companion addon never buy, list, click or act. They record and advise.
2. **Seller identity,** which Blizzard does not publish.
3. **The Horde house, other rulesets for Chip, Hardcore, and the Black Market blind bids.**
4. **Importing Auctionator scans or third party price feeds.**
5. **Deferred to phase 2.** Classic only and candidate vendor tiers, vendor restock timers, raid consumable planning.

## 19. Open decisions

| # | Decision | Recommended default |
| --- | --- | --- |
| 1 | Alert channel | A private Discord server with a channel per person. Free, already on most phones, and it scales to his brothers without changes |
| 2 | Value of his own gathered inputs in make or buy | What he could have sold them for, with free and his own time as the other two settings |
| 3 | Profit bar | 25 silver, raised as capital grows |
| 4 | Listing rules assumed until T7 | Classic deposit formula with a 1 copper minimum, five times at Blackwater, and a 1 silver minimum listing price, which matches the November 18 reports and is the conservative reading |
| 5 | Default selling house | Alliance, because its cut is ten points lower. Blackwater only when a gap covers its cut |
| 6 | Default kills per hour for world drops | 60 for normal enemies, 20 for elites, one run an hour for dungeons, labeled estimated, editable, and replaced by measured rates once he times a source |
| 7 | Companion addon timing | After December 9 as planned. Move it earlier if typing positions by hand becomes the thing that stops him using the tool |

## 20. Project docs this spec corrects

1. **Bright Baubles vendor.** Nerrist is Horde. Alliance sellers include Old Man Heming in Booty Bay at 2s 50c at Neutral.
2. **Deposit.** The 1 copper deposit was not live November 10, reportedly arrived November 18, and a 1 silver minimum listing price may remain.
3. **Mister Graphed.** Two guide sources and a video place him in Powderfuse Port selling at fixed prices, but no source lists his prices. Treated as reported until Chip records them.
4. **API facts.** The ruleset in the URL is cosmetic and the house id selects the market. Refresh is about hourly per house. Both verified.
5. **Single market assumption.** Chip trades on two houses with different prices and cuts, so the cross house flip exists.
6. **Drop rate data.** Earlier research said no Forever drop rates exist anywhere. Player recorded Forever loot data does exist, thin but growing.

## 21. The overnight improvement loop

The tool improves itself while Chip sleeps and tells him what changed when he gets on. Two halves keep that safe and cheap.

### 21.1 What runs when

1. **The engine runs all day and uses no Claude at all.** Capturing snapshots, finding plays and sending alerts is ordinary scheduled code every 15 minutes, so alerts keep working through the day at zero cost to Chip's Claude usage.
2. **The improvement loop runs once a night, inside a window,** by default 1am to 6am his time. If a run starts outside the window, such as a catch up after the PC slept, it exits without doing anything, so it never eats daytime usage.

### 21.2 The roles

Each role is its own agent with one job, and only the implementer can change code.

| Role | Job |
| --- | --- |
| **Master** | Reads the day's run reports and the open issues, decides what to work on, enforces the caps, writes the changelog. Never writes code |
| **Auditor** | Checks that the data is right, in the right shape, and complete enough for every detector, using the rules in the verification ledger. Files each problem or optimization as an issue with evidence |
| **Architect** | For anything beyond a small fix, writes the plan. What changes, what it touches, and how the tester will prove it |
| **Implementer** | Makes the change on its own copy of the code, following the plan |
| **Tester** | Proves the issue is fixed with a test that failed before and passes after, runs every existing test to prove nothing else broke, and takes a fresh pull when the change touches data |
| **Reviewer** | Reads the change itself. Is it limited to what the issue needs, clean, efficient and minimal, and does it touch anything it should not |

Small fixes skip the architect, to save usage. A fix is small when it changes one file and nothing about stored data. The master decides.

### 21.3 The cycle

1. The auditor files an issue.
2. The master picks the most valuable issue that fits the remaining budget for the night.
3. The architect plans it, unless it is small.
4. The implementer builds it.
5. The tester and the reviewer both check it. Both must pass.
6. If either fails, their findings go back to the implementer for another round.
7. When both pass, the change goes live and gets a changelog entry.

Only one change is in flight at a time, so any revert is clean.

### 21.4 Going live, and reverting

1. **Passing changes go live on their own.** Chip reviews the changelog afterward rather than approving beforehand.
2. **History is protected.** Before any change that touches snapshot capture or stored history goes live, the history is backed up, and the change must capture one fresh snapshot successfully.
3. **Live changes are watched until morning.** If any check that passed before the change now fails, the change is reverted automatically and the changelog says so.
4. **Stop rules for a cycle going wrong.** At most three rounds per issue. A round counts as worse when more tests fail than in the round before, or the reviewer finds the change growing beyond the issue. A worse round, or a third failed round, reverts to the last good state, marks the issue "needs Chip", and stops work on it. A small issue Chip can advise on beats two agents digging a hole.
5. **A few changes never go live without Chip.** Deleting stored data, changing the profit definitions in this spec, changing alert, budget or schedule settings, and adding new data sources or credentials. These become proposals in the changelog instead.

### 21.5 The changelog

Each morning a short message lists what happened overnight, and the full changelog lives in its own section of the tool. Every entry shows the date, the issue and how it was found, what changed in plain words, the files touched, the tests added, the reviewer's notes, its status of live, reverted or needs Chip, the usage it cost, and how to undo it.

### 21.6 Usage limits

1. **Hard ceiling.** Usage credits stay off on Chip's plan, so reaching a limit blocks the loop instead of billing him.
2. **No waiting on limits.** A run that hits a limit stops for the night. It never waits for the limit to reset and continue into the morning.
3. **Caps per agent and per night.** Each agent has a turn limit, and the master stops picking new issues once the night's budget is spent.
4. **Starting caps,** to be tuned after the first two nights. At most two issues a night and three rounds each.
5. **Usage is reported.** Every night's changelog shows what the loop used, so the caps can be adjusted with real numbers.

### 21.7 Where it runs

On Chip's PC, as a Claude desktop scheduled task, because the loop needs the local code and history. The app stays open overnight with the computer kept awake. A night the PC sleeps through is simply skipped.
