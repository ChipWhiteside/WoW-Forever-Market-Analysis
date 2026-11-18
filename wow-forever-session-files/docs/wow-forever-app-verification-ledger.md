# WoW Forever App: Verification Ledger

What we have actually proven about the API and data sources, what we only believe, and the rule that keeps the two apart. Created November 17, 2026 after two silent failures in one session. The gold finder spec's data inventory and test list build on this ledger.

## The failure mode, named

Three instances so far, all the same mistake in different clothing.

1. `item` sounded like a number, so the extractor read `a.item` instead of `a.item.id`. It matched nothing. Output said every marker item was not listed across 300,000 auctions.
2. `commodities` sounded like an array, so the code called `.length` on it. It is a link object. Output said zero commodities, and we spent two days believing Forever had no raw material market while sitting on 111,670 commodity listings.
3. **The verification script itself.** It compared rulesets using a fingerprint that included the row count, so a difference of 7 rows in 111,670 printed "rulesets differ". They do not. A brittle test produced a confident wrong verdict inside the tool written to prevent the first two.

A related near miss on November 18. The docs named Nerrist as Chip's Bright Baubles vendor for a week, and nobody checked his faction. He is Horde. A name in a guide was taken as evidence that the vendor was usable.

## THE RULE (binding, every session)

1. **Never infer a shape from a name.** Print one real record before writing any code that reads it.
2. **Zero, empty and not found are suspected bugs until proven to be market facts.** An empty result gets a deliberate check against a second source or a known truth before it is reported as a finding.
3. **A claim from a forum, a guide or a previous session is unverified until this project has run it.**
4. **A verdict must name its comparison, and the comparison must be the strictest available.** Compare id sets, not counts. Compare content, not shape. A near match is a match and must be reported as one.
5. **Every new belief gets a row in the register below,** with its status and the test that would settle it.
6. **Bring the unverified ones to Chip rather than building on them silently.**

## Verified, with our own calls

| # | Fact | Verified |
| --- | --- | --- |
| V1 | Credentials work. Token valid 24 hours. `static-forever-us`, `dynamic-forever-us` answer | Nov 17 |
| V2 | Equipment auctions carry `id`, `item.id`, `buyout`, `quantity`, `time_left`, and `bid` on roughly 16 of 5,000 | Nov 17 |
| V3 | Raw materials live at `/data/wow/ruleset/{rs}/auctions/{house}/commodities`, and that response returns its rows under the key `auctions`, not `commodities` | Nov 17 |
| V4 | Commodity entries carry `unit_price`, already per unit | Nov 17 |
| V5 | No seller, owner or character field exists anywhere in auction data | Nov 17 |
| V6 | `sell_price` and `purchase_price` are populated on items. Linen Cloth 13c and 55c, Copper Ore 5c and 20c, Copper Bar 10c and 40c, Oily Blackmouth 4c and 16c, Raw Longjaw Mud Snapper 1c and 20c | Nov 17 |
| V7 | `purchase_price` is populated for items no vendor sells, so it is a candidate filter and never a proof | Nov 17 |
| V8 | Professions are in the API. 13 returned. Blacksmithing is 164, one skill tier, 33 categories, 507 recipes | Nov 17 |
| V9 | Recipes return crafted item id, crafted quantity and a full reagent list. Recipe 1631 Rough Sharpening Stone, crafts 2862, one Rough Stone | Nov 17 |
| V10 | `static-forever` and retail `static` disagree on at least one id. Item 6712 is Practice Lock in Forever and Clockwork Box in retail. Never fall back to retail for names | Nov 17 |
| V11 | The Alliance houses hold genuinely different prices from each other | Nov 17 |
| V12 | House 112 returns no auctions and no commodities. Dead house | Nov 17 |
| V13 | Every equipment auction is quantity 1, all 133,458 of them, none carrying `unit_price`. Buyout is the unit price for equipment | Nov 18 |
| V14 | `Last-Modified` is present on the house, commodities and index endpoints | Nov 18 |
| V15 | Two consecutive pulls of the same endpoint return identical data | Nov 18 |
| V16 | **The ruleset in the path is cosmetic.** Rulesets 1 and 2 returned house 110 commodities sharing 111,670 of 111,671 auction ids. The house id alone selects the market | Nov 18 |
| V17 | **Snapshots are hourly, not live.** House 110 commodities held one `Last-Modified` from 04:25 for at least 52 minutes, with zero ids added or removed across six polls a minute apart, and `If-Modified-Since` returned 304 every time | Nov 18 |
| V18 | **Cuts are 5 percent Alliance and 15 percent Blackwater,** from Chip's own November 15 sales | Nov 15 |
| V19 | **Expired listings keep the deposit,** from Chip's mailbox | Nov 15 |
| V20 | **EG Link output on GitHub holds Forever vendor recordings** with price by standing, units per purchase, limited flag and position. Nerrist's row reads Bright Baubles at 250c Friendly and 225c Honored. 361 distinct vendors across 13 builds | Nov 18 |
| V21 | **SkillScribe on GitHub holds 2,130 recipe threshold rows,** about 428 of them Blacksmithing. Rough Sharpening Stone reads 15, 35, 55 | Nov 18 |
| V22 | **Nerrist is Horde.** Alliance usable Bright Baubles sellers in Forever recordings include Old Man Heming in Booty Bay, Edna Mullby in Stormwind and Christopher Hewen in Westfall | Nov 18 |

## Unverified, currently believed

| # | Claim | Risk if wrong | Test |
| --- | --- | --- | --- |
| U4 | Which Alliance house and which Blackwater house are Chip's | Every number belongs to another realm | Chip's in game check, spec step 2 |
| U8 | Recipe skill thresholds map cleanly onto API recipes | Craft ranking misses or mislabels recipes. About 80 API Blacksmithing recipes have no SkillScribe row | Spec test T3 |
| U9 | Item names resolve for nearly all auction ids | Unnamed items in the feed | Spec test T2 |
| U11 | Minimum listing price is 1 silver and the deposit minimum is 1 copper | O1 yield and deposit math | Spec test T7 |
| U12 | Item `binding` is present in Forever item responses | Bind on pickup crafts shown as sellable | Spec test T1 |
| U13 | Vendor faction joins cleanly | Horde vendors shown to an Alliance player | Spec test T4. A naive match already returned wrong lines for two vendor ids |
| U14 | Mister Graphed sells at fixed gold prices | Price ceilings in the strategy doc are false | Chip in game, or a second source |
| U15 | The profile endpoint returns Chip's professions | Manual entry needed | Spec test T8 |

## Claude's own corrected claims

| Claim Claude made | Status |
| --- | --- |
| Recipes are retail only and must come from client files | **Wrong.** Professions and recipes are in `static-forever` |
| Unit price is buyout divided by quantity, and nothing matters more | **Moot.** Equipment is quantity 1, commodities carry `unit_price` |
| Forever has no commodity market | **Wrong.** The key is a link to 111,670 listings |
| The ruleset path segment selects a market | **Wrong.** Cosmetic, V16 |
| The feed may be live rather than hourly | **Wrong.** Hourly, V17. The timestamp spread came from separate houses publishing at different times |
| Nerrist is where Chip buys Bright Baubles | **Wrong.** Horde vendor, V22 |
| The 1 copper deposit went live November 10 | **Wrong.** Pulled, then reportedly live November 18 |

## How a row moves

An unverified row becomes verified only when this project has run the test and recorded the result with its date. Nothing graduates on the strength of a guide, a forum post or a previous session's confidence. When a test disproves a claim, the row stays with the correction.
