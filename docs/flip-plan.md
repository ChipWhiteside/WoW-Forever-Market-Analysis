# The Flip Engine: plan for the next phase

Version 1, November 23, 2026. Planning only. Nothing here is built yet. When Chip approves it, this plan wins over `docs/build-plan.md` for everything about finding and ranking flips. The leveling planner, alerts, the map and the overnight loop stay as they are and are out of scope for this phase.

## 1. The goal, in one paragraph

Every hour, at about 25 past, Blizzard publishes every listing on Chip's houses. Within minutes the engine reads all of it, joins it to a complete, verified database of recipes, vendors and items, and tests every way to turn copper into more copper: buy and resell, buy and craft, vendor to auction, auction to vendor, one house to the other. It throws out anything that is fake, too thin, or not worth his time, and shows one ranked list. The best flip is on top. He can scroll as far as he likes. Each one says what to buy, where, how many, what to do with it, where to sell it, for how much, and why the tool believes it.

**The quality bar is the flips, not the page.** A flip on the list must be real (the prices and sales behind it exist right now), profitable after every fee, sellable at the volume claimed, and worth the hours it takes.

## 2. The yardstick: two real flips and their mirror images

Chip gave two flips that clear the bar. Both have since closed, which is the point: the tool exists to catch them in the hours they are open.

| Flip | What it was | What it must do in tests |
| --- | --- | --- |
| **Cerulean Dye** (Ben's) | Alchemy. 2 Frilled Lichen at 25 to 30s each plus 1 Empty Vial (4c from a vendor), about 50 to 61s all in. The dye sold for 70 to 80s and moved fast. About 9 to 19s profit each | A recorded market at those prices **must** produce this flip, near the top |
| **Bright Baubles** (Chip's) | Old Man Heming on the Booty Bay docks sells them for 2s 50c (verified in EG Link). They sold near 5s on the Booty Bay (Blackwater) house. After the 15% cut, about 1s 75c profit each | A recorded market at those prices **must** produce this flip |
| **Both, today** | The prices have fallen to match cost | Today's live listings **must not** produce either one |

Checked against real data this session:
- Cerulean Dye is item 249409, an Alchemy recipe (SkillLineAbility 54453, taught at Alchemy 40 for 1s 50c). It takes 2 Frilled Lichen (249399) and 1 Empty Vial (3371) and makes 1. Blizzard's recipe API and the game tables agree.
- **No quest in any EG Link record needs Cerulean Dye.** What does need it: about 130 recipes, mostly new Forever Tailoring pieces, plus the Runecloth and Mooncloth Bags, which Forever changed to need dyes. So its demand came from crafters, not from a quest. That matters: the tool should treat "a reagent many recipes need" as a strong reason for steady demand.
- Bright Baubles is item 6532, Old Man Heming sells it for 250c at Neutral and Friendly.

## 3. Where we are: an honest audit

### What already serves the goal (keep)
1. **Live collection works.** The engine polls every house every 2 minutes, stores each hourly publish, and keeps raw snapshots for replay. Live from this session today: house 111 has about 120,000 equipment listings over 5,593 items and 92,000 commodity listings over 1,345 items.
2. **Sales are inferred carefully.** Blizzard publishes no sales. The collector compares each hour's listing ids with the last hour's, and leaves out expiries, cancels, relists and mass cancels (B17, B18). This is the only possible source of "how fast does it sell", and it is already built well.
3. **Prices resist trolls.** A TSM style market price (cheapest 15 to 30% of units, outliers trimmed), sold price caps, and junk gates.
4. **Vendors are right.** EG Link vendors filtered to what an Alliance character can use (Nerrist excluded, verified).
5. **Fees are verified.** 5% Alliance cut, 15% Blackwater, deposit measured from Chip's own listing.
6. **Make or buy math exists.** `src/craft/makeOrBuy.ts` walks every recipe tree and picks the cheapest of auction, vendor or craft at each node.
7. **Five detectors** produce plays: vendor dump, vendor to auction, cross house, underpriced relist, sell now.

### What does not serve the goal (the holes)
1. **Crafting flips never reach the ranked list.** `Engine.detect()` (`src/engine/engine.ts`) runs five detectors and none of them crafts. Crafting lives on a separate Profit board, sorted first by "can you make it now", which is the opposite of Chip's rule that trainable requirements never disqualify a flip. The single most important flip type is not on the main list.
2. **Bind on pickup products look sellable.** Blizzard's item API never returns `binding` for Forever items (0 of 2,361 checked today). `src/catalog/items.ts` stores that null, so every product reads as unbound. A bind on pickup craft could be shown as a flip. The game's own item table (`ItemSparse.Bonding` on wago.tools) has it.
3. **Reagent cost ignores depth.** The board prices each reagent at one trusted price. Buying 200 Frilled Lichen walks up the listings and costs more per unit than buying 2. A volume flip looks better than it is.
4. **Sell volume is not tied to the flip.** The board shows sales a day but ranks Chip's craftable recipes first, and does not cap units by how many the market absorbs, how many units sit ahead of him, or how deep the reagent supply is.
5. **No effort model.** Nothing knows that 2,000 crafts for 2c each is a bad hour. The only guard is a flat 1s minimum profit per item, which also blocks good high volume flips at a few copper.
6. **Recipes come only from Blizzard's API,** which drops a reagent after an empty slot (White Wedding Dress loses its Bleach), stores 1 to N ranges for random yield bombs, and includes Season of Discovery recipes whose items are not in Forever (only 2,157 of 2,495 are fully live). The game tables on wago.tools are more complete and must be cross checked against it.
7. **Blackwater is not covered.** Chip's Blackwater house is still unconfirmed (P6), and once a house is pinned, only pinned houses make plays. The Bright Baubles flip was a Blackwater flip, so today it could not appear.
8. **No disenchanting.** No public source has disenchant outputs for Forever (checked today). This needs hand entry and in game proof.
9. **No conversions.** Item use crafts outside the profession tables (for example "Dust to Motes", essence combines) are not read.

LIVE RUN FINDINGS: (filled from the live end to end run)

## 4. The data: what we need, where it comes from

Two kinds of data. **Static** data changes only when Blizzard ships a build. It is downloaded, checked and stored locally, so the hourly run never waits on the internet for it. **Live** data is the hourly auction snapshot.

### Static database, refreshed daily and whenever the build changes

| Need | Source (verified today) | Why this one |
| --- | --- | --- |
| Every recipe, its reagents and quantities | wago.tools game tables for the live `wowf` build (1.60.1.71037): `SkillLineAbility`, `SpellReagents` | 2,706 profession recipes. Reads all 8 reagent slots. Matches Blizzard on 2,493 of 2,494 shared recipes |
| What a recipe makes, and how many | wago `SpellEffect` (create item), cross checked with Blizzard `/data/wow/recipe/{id}` | 0 product mismatches. Random yields (9 Engineering bombs) disagree between sources, so they are flagged until Chip crafts a few |
| Recipes wago lacks | Blizzard recipe index, as a union | Catches the rare one (Centaur Hoofwarmers) |
| Is this item really in Forever | wago `ItemSparse` row exists | Blizzard 404s exactly the items with no row (345 of 345). Filters out Season of Discovery leftovers |
| Binding, stack size, vendor sell price, vendor buy price and bundle size, quality, class | wago `ItemSparse` and `Item` | Binding exists only here. The rest matched Blizzard on all 2,361 items checked |
| Craft cast time | wago `SpellMisc.CastingTimeIndex` plus `SpellCastTimes` | Feeds the effort model. To be fetched and checked against a timed craft in game |
| Cooldowns (transmutes, Mooncloth) | wago `SpellCooldowns`, `SpellCategories` | Caps units a day for 23 profession spells |
| Item use conversions | wago `ItemEffect` plus `SpellEffect` | Dust to Motes and similar. Only Forever live items kept |
| Vendors, prices by standing, limited stock | EG Link vendors (already used) | 1,062 gold priced items. 82 of 589 reagents are vendor sold. Limited stock has an observed max but no restock timer |
| Where and for how much a recipe is learned | EG Link trainers (already used), recipe items from `ItemEffect` | One time setup cost shown on the flip, never a reason to hide it |
| Why people buy it | EG Link quests (already used), plus "number of recipes that use it" | Demand reason on the card |
| Disenchant outputs | None published. Hand entered classic table, marked unverified until checked in game | Phase 2 of this plan |

Every source is fetched, validated against a data contract, compared with the second source where one exists, and written to SQLite with its build id. A recipe the two sources disagree on is kept and flagged, never silently dropped or silently trusted.

### Live data, every hour
The commodities and equipment snapshots for Alliance 111 and Chip's Blackwater house (to confirm, section 10). The collector already does this. Kept as is.

## 5. How the engine finds every flip

### The idea: one price for every item, from every source
For every item the engine computes two things each hour:
- **What it costs to get N of it:** the cheapest mix of buying on either house (walking the listings, so the 200th unit costs what the 200th unit really costs), buying from a usable vendor (fixed price, capped by limited stock), or crafting it from its own reagents (recursively, with the same rule at each level).
- **What N of it nets when sold:** on either house after the cut, never above where real sales happened, or to any vendor.

Every flip is then a path from the first to the second. That one structure covers every flip type with the same math, so a Cerulean Dye and a Bright Baubles are judged by the same rules.

### Flip families, all on one list

| Family | Path | Status |
| --- | --- | --- |
| **Craft** | Buy reagents (auction or vendor, any depth of intermediates) → craft → sell on auction or vendor | **New on the main list.** The core of this phase. Covers smelting, cooking, first aid, alchemy, tailoring and the rest |
| **Vendor to auction** | Buy from a usable vendor → sell on a house (Bright Baubles) | Exists. Extended to both houses |
| **Auction to vendor** | Buy under vendor price → sell to any vendor | Exists |
| **Cross house** | Buy on one house → sell on the other | Exists |
| **Cheap listing** | Buy well under the usual price → relist on the same house | Exists |
| **Conversion** | Item use crafts (Dust to Motes, essences) | New, after craft |
| **Disenchant** | Buy green gear → disenchant → sell dust and essences | New, last, behind the unverified label until proven |

### How a craft flip is computed, step by step
1. For each live recipe whose product can be sold (not bind on pickup, has an auction price or vendor price):
2. **Sell side.** Judge the product's price on each house with the existing troll proof price rules. The price a flip may claim is never above where sales happened.
3. **Volume.** Sales a day for the product on that house, from the listing id differences, with how many hours of watching are behind it.
4. **Quantity.** Start from Chip's realistic share of daily sales (20% today, calibrated later). Cap by recipe cooldowns, vendor limited stock and gold on hand. Then find the best quantity: keep adding one more craft while the next one still makes money, using the true cost of the next unit of each reagent from the listings.
5. **Cost side.** For that quantity, the cheapest way to get every reagent, including crafting intermediates when that is cheaper (smelt the bars, or buy them).
6. **Fees.** Cut on the sale, deposit risk from the listing plan, vendor bundle sizes (vials come 5 at a time).
7. **Effort.** Minutes to do it (section 6).
8. **One time setup.** If Chip lacks the recipe or the skill: trainer cost and where, or the recipe item and its price. Shown, never hidden.

Every other family runs the same steps with a different path.

## 6. How the engine ranks them: the theory

What makes a flip good, in Chip's words: it makes real money, it sells, and it is worth the time. Turned into numbers:

### Step 1: hard gates (a flip that fails any of these is held back, with the reason shown)
1. **Real.** The sell price passes the existing junk checks, and real sales were seen near it. A big number on thin evidence is a red flag, never a flip.
2. **Profitable.** Profit each after the cut, at the best quantity, is above zero with a safety margin of at least 5% of the sell price, so one undercut does not wipe it out.
3. **Sells.** At least 1 sale a day on that house.
4. **Possible.** Every reagent has a source. The product is not bind on pickup. Requirements Chip can train never fail this gate.
5. **Worth the time.** Gold per hour of effort is at or above Chip's floor (section 10, the one question). This replaces the flat 1s minimum for flips on this list: a flip that makes 3c each but sells 2,000 a day in one commodity listing can pass, and 2,000 crafts for 2c each cannot. The old 1s setting stays and keeps doing what it does on the Now page.
6. **Fresh.** Built from this hour's snapshot. When the gap closes, the flip is marked gone at the next publish.

### Step 2: the numbers each flip carries
- **Profit each** (the big number, as today).
- **Units a day** worth doing: min of his share of sales, cooldowns, stock, gold, and the best quantity.
- **Profit a day** = profit each times units a day, using the true cost of each unit.
- **Gold per hour** = profit a day divided by hours of effort.
- **Effort** = crafting time (cast time times crafts) + buying (one action per commodity purchase, one per equipment listing) + posting (one action per commodity stack, one per equipment item) + a trip when a vendor or trainer is not at the auction house. Each constant is written down and tuned from Chip's real times.
- **Strength 0 to 100** (exists): days of history, listings holding the price, sales seen, sold near this price, steady price, why people buy it, junk checks. Plus two new factors: supply ahead (units listed at or under his price divided by sales a day, "days to clear") and reagent depth (whether the listings can actually supply the quantity).
- **Opening**: how far today's gap is above the item's usual gap, so a fresh opening like Cerulean Dye's reads as new, not as an old steady flip.

### Step 3: the rank
**Expected gold a day** = profit a day times strength as a probability (a 90 strength flip counts 90% of its gold, a 50 strength flip half). Highest first. Ties broken by gold per hour.

Why this order: Chip thinks in profit each and units a day (already agreed as the sort: profit each times realistic units). Weighting by strength stops a big number on weak evidence from outranking a solid smaller one. Gold per hour is a gate, not the sort, because a flip worth 2g a day at 200g an hour is still only 2g.

### Worked through on the yardstick
- **Cerulean Dye at Ben's prices:** cost about 58s, sells 75s, net after 5% cut about 71s, about 13s each. If it sold 60 a day, his 20% share is 12 a day: about 1g 56s a day, one purchase of each reagent, 12 crafts, one post. Minutes of work, so gold per hour is high. Passes every gate. Ranks by its 1g 56s a day times its strength.
- **Bright Baubles at Chip's prices:** 2s 50c in, 5s on Blackwater, 4s 25c net after 15%, 1s 75c each. Ranks by units a day times that, minus a trip to the docks in the effort.
- **2,000 crafts for 2c each:** 40s for about 100 minutes of casting. Fails the gold per hour gate. Held back with "under your gold per hour floor".
- **Today's live dye and baubles:** profit each at or below zero after the cut. Fails gate 2. Not shown.

## 7. The hourly loop
1. Publish detected (about :25). Snapshot stored, sales counted (exists).
2. Build the price book for both houses: every item's ladder, judged price, sales a day, steadiness.
3. Build the cost book: cheapest way to get each item, computed once per item and reused by every recipe that needs it (memoized, exists in part).
4. Run every family over every item and recipe. Gate, score, rank.
5. Store the ranked list, mark flips new, live, fading or gone (lifecycle exists).
6. Write a run report: items read, recipes tried, flips found, held back by reason, time taken, and anything that looked like a bug (a zero, an empty, a missing source).

**Correctness over speed.** No time limit ever cuts a run short. Every run covers every item, every recipe and every vendor. Run time is logged so slowness can be investigated, never trimmed. A run that cannot finish properly shows "incomplete" and why, never a partial list as if it were whole.

## 8. Current code: what stays, what changes, what is new

| Area | Verdict | Change |
| --- | --- | --- |
| Collector, snapshots, sale inference (`src/engine`, `src/analysis/aggregate.ts`, `history.ts`) | **Stays** | Read both houses for flips, not only pinned Alliance |
| Price rules, fees (`src/rules`) | **Stays** | Protected. New gates and weights proposed here, added as new constants with Chip's approval on this plan |
| Item catalog (`src/catalog/items.ts`) | **Changes** | Binding, stack size and vendor bundle from ItemSparse. Live item filter |
| Recipes (`src/datasets/recipes.ts`) | **Changes** | Primary source wago tables, Blizzard as cross check and union, disagreements flagged, cast times and cooldowns added |
| Make or buy (`src/craft/makeOrBuy.ts`) | **Changes** | Depth aware cost for N units, both houses, vendor bundles and stock. Profit board keeps its columns (page contract) |
| Detectors (`src/detectors`) | **Stays and grows** | New `craft` and `conversion` families. All families share one gate and scoring module |
| Ranking | **New** | `src/flips/` : cost book, sell book, effort model, gates, score, rank. Pure functions, fully unit tested |
| App | **Grows** | A new **Flips** page with the ranked list, first in the menu. Nothing on Now, Crafting or the play card is removed or moved (additive rule). Page contract and its test gain the Flips page |
| Leveling, map, alerts, overnight loop | **Untouched** | Out of scope this phase |

## 9. How every piece gets checked, at least three times

Each layer has three independent checks: a test with hand calculated numbers, a check against live data, and a fresh agent that reviews the code and the output with no stake in it. Then every layer is checked again together.

| Layer | Check 1: tests | Check 2: live | Check 3: independent review |
| --- | --- | --- | --- |
| Static data | Data contracts on every file; 20 known recipes by hand (Copper Bar, Minor Healing Potion, Linen Bandage, Cerulean Dye...) | wago and Blizzard compared recipe by recipe; every disagreement listed | Agent picks 30 random recipes and checks each against the raw files |
| Prices and volume | Ladder walk costs by hand; a market simulator with known buys, cancels, expiries and relists, scoring how close sale inference gets to the truth | Real snapshots: inferred sales a day for 20 items against what the ladders show | Agent recomputes 20 items' prices and sales from raw snapshots by its own code path |
| Flip finding | Golden tests: Cerulean Dye and Bright Baubles at Chip's numbers must appear; at today's numbers must not; bind on pickup never appears; a blocked reagent never appears | Full live run over every recipe and item | A separate script, written by a different agent, recomputes the top 25 flips from raw JSON and must agree |
| Ranking | Scenario tests: high volume low margin, low volume high margin, 2,000 crafts for 2c (rejected), a troll price (rejected), a thin market (weak strength) | Top 25 on live data, each traced to its evidence | Agent argues against each of the top 10 ("why is this a bad flip?"), and any it wins becomes a test |
| Whole loop | `npm test`, typecheck, replay of stored snapshots, page contract test | The engine runs here on live data across several publishes | A final fresh reviewer reads the whole diff and the run reports |

**Backtest, the strongest check.** As hours of history build up, every flip shown at hour T is checked at T+1 to T+6: did the gap still exist, and did the product actually sell near the claimed price? That hit rate is the tool's real score and goes in the run report.

## 10. What I need from Chip

One question now. The rest can wait.

**The question: what is an hour of your play time worth in gold right now?** That becomes the gold per hour floor in gate 5. My proposed default is 5g an hour for phase 1, where most trades are in silver. Both of your yardstick flips clear that easily, and 2,000 crafts for 2c each does not.

Later, not blocking:
1. Your Blackwater house id. Without it, Blackwater flips (like Bright Baubles) cannot be shown. A few Booty Bay screenshots with prices settle it, as they did for 111.
2. Craft one random yield bomb a few times (Coarse Dynamite), to settle the yield formula.
3. Time yourself on one craft batch and one posting session, to tune the effort model.

## 11. Build order after approval
Each step runs the full check loop in section 9 before the next starts. Agents work in parallel where steps do not depend on each other.

1. Static database from wago and EG Link, with binding fix and live filter. Cross check against Blizzard.
2. Cost book and sell book with depth aware ladders, both houses.
3. Craft family, then the other families moved onto the shared gate and score module.
4. Effort model, gates, score, rank, run report.
5. Flips page, page contract updated.
6. Backtest harness on collected history, run the engine here on live data, golden and scenario tests, independent recomputation.
7. Conversion family, then disenchant behind the unverified label.
8. Tutorial walkthrough for Chip.
