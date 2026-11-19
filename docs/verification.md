# Verification record, this build

Every fact the code relies on, how it was checked, and when. Extends the original ledger in
`wow-forever-session-files/docs/wow-forever-app-verification-ledger.md` (V1 to V22 stay valid).

## Proven in this build session, November 18, 2026

| # | Fact | How |
| --- | --- | --- |
| B1 | EG Link live data is at `JIVESCORP/eg-link-output-wowf`, product `wowf`, 19 builds, CC BY 4.0 | Fetched index.json and every build's vendors, npcs, creatures, loot, item hotfixes |
| B2 | Some EG Link vendors have no `entries` key | First merge run crashed on it, now handled and tested |
| B3 | Vendor faction is decidable from which faction's players saw the NPC and its reaction to them. Nerrist: Horde only at Friendly. Edna Mullby: Alliance. Old Man Heming: seen only at Neutral, so a neutral goblin vendor | Live merge, test T4 passes: Alliance usable Bright Baubles sellers are Edna Mullby, Christopher Hewen, Gorbold Steelhand, Old Man Heming, Kilxx and Zizzek. Nerrist and every Horde vendor excluded |
| B4 | EG Link vendor prices are keyed by standing; Honored is 90 percent of base. Edna's only record is 225 at Honored, so base is 250 | Live rows, Friendly 250 and Honored 225 on the same NPCs |
| B5 | wago.tools publishes the live `wowf` build tables (latest 1.60.1.70959) | `/api/builds` |
| B6 | Blizzard recipe id equals `SkillLineAbility.ID`. Row 1631 (Rough Sharpening Stone) has TrivialLow 15, TrivialHigh 55; green is the midpoint 35. Matches SkillScribe's 1, 15, 35, 55 | Downloaded CSV, test T3 bar met |
| B7 | `MinSkillLineRank` is often 1 even for recipes learned higher (Smelt Bronze reads 1, learned at 65) | Same CSV. Learn skill falls back to yellow when no trainer row exists |
| B8 | Mining the same vein with different spell ranks splits EG Link loot keys; merged per object, Copper Vein has 184 recorded nodes | Live merge |
| B17 | **Fake plays came from three stacked faults,** reproduced line for line with the real code (Blacksmith Hammer, 76g): 2 hour listings that expired and were reposted counted as sales (only SHORT was treated as expiring), the sell price was the single cheapest listing (a 90g troll), and sales counted near an old 1s floor were multiplied by the new 90g one | Trace agent, November 19 |
| B18 | **Fixed:** listings last seen with under 2 hours left (SHORT or MEDIUM) are never sales; a cancel and relist on a thin market is not a sale; a stackable that vanished while a cheaper one is still up was cancelled (the buy window fills cheapest first); a house where over 30% of listings vanish at once is skipped; sales record the price they happened at; a play never claims a sell price above where sales happened; common items over 20x vendor price and vendor items over 20x the vendor's price need 3 sales at that level; confidence is a 0 to 100 score (TSM style factors), below 40 hidden, below 60 never alerted | Tests in tests/unit/aggregate.test.ts and detectors.test.ts |
| B15 | **Deposit is 20 percent of the vendor price per hour, per unit, on the Alliance house.** Coarse Stone (vendor 15c) cost 6c for 2 hours, 24c for 8, 72c for 24 | Chip's own listing, November 19 |
| B16 | **Forever changed recipe learn ranks.** Trainers teach Rough Bronze Leggings at 80 and Bronze Warhammer at 100, and Green Iron Leggings costs 50s | EG Link trainer recordings, build 1.60.1.70938 |
| B14 | **House 111 confirmed against every other house.** Screenshot levels 7 onward (39 levels): house 111 has 19 exact, 8 within 10 percent, 0 missing. Every other Alliance and Blackwater house has 0 exact and is missing 25 to 39 of the 39 prices | `npm run compare-houses`, November 19, 9:25 snapshot |
| B13 | **The in game auction house is live; the API is a frozen snapshot.** Full ladders for house 111 (9:25 snapshot) against Chip's Stormwind screenshots: the deep tail matches exactly (Copper Ore 1s 4c x32, 1s 6c x154, 1s 7c x69, 1s 37c x2; Copper Bar 1s 11c x117, 1s 14c x94, 1s 16c x56, 1s 29c x76; Linen 31c to 50c, 14 of 16 steps exact). Differences sit almost entirely in the cheapest few steps, which trade fastest. Same market, different moment | `npm run ladder` for three items, November 19 |
| B12 | **All houses publish together, about 25 minutes past the hour.** Eight houses' Last-Modified fell between 9:24:54 and 9:25:02 AM. Matches the 04:25 publish of house 110 on November 18 (V17) | Chip's `npm run publish-times`, November 19 |
| B11 | **Chip's Alliance house is 111.** Matched against his Stormwind screenshots by price ladder: 33 of 57 price steps on 111, at most 1 on any other Alliance house. Every in game total was higher than the API's on all three items. The partial match is NOT explained yet: Chip saw no publish between screenshot and run, so the working theory is that the in game house is live while the API snapshot is frozen (see P7) | `npm run match-house`, November 19 |
| B10 | Dead house 112 answers the commodities endpoint with 200 and no `auctions` key at all, not an empty list. The contract now reads a missing key as zero listings and flags it | Chip's live run of match-house crashed on it, November 19 |
| B9 | This cloud container reaches Blizzard, GitHub raw, wago.tools and Discord | curl from the session |

## Not yet proven, blocking or provisional

| # | Claim | Status | Settled by |
| --- | --- | --- | --- |
| P1 | Live auction shapes still match the contracts in `src/blizzard/contracts.ts` | Contracts written from V2 to V17 records. Not re-run in this build because the cloud credential was rejected | `npm run contract` on first run, setup runs it too |
| P2 | Item `binding`, `quality`, `media` fields present in Forever item responses (T1, T11) | Provisional | `npm run contract` checks binding and icon |
| P3 | Blackwater deposit is 5 times the Alliance deposit, and deposits come back when an item sells | Guide claim and Classic behaviour, not yet seen | One Blackwater listing, and one sale's mail |
| P4 | Demand from vanished listings | Provisional by nature: cancellations leak in. Excludes listings that were about to expire | Calibration report over weeks |
| P5 | Character professions from the profile API (T8) | Not wired. Professions are typed in Settings as JSON | Later release |
| P8 | The thresholds in src/rules/price.ts (15 to 30% of units, 1.2 jump, 1.5 SD trim from TSM; 20x outlier gates; score cut offs 40 and 60) are right for an early silver economy | Starting values, unverified | Calibration report after a week: share of shown plays Chip finds real |
| P6 | Chip's Blackwater house (Alliance is 111, B11) | Candidates 116, 117, 121, 125 | Booty Bay ladders into match-house |

## Hand calculated checks in the test suite
O1 vendor dump, O2 Bright Baubles at 4s 80c, O7 Wool Cloth Alliance to Blackwater, O3 Copper Ore 40 percent under typical,
Copper Bar make or buy, value per kill for a two item source, 20 Copper Ore in 10 minutes reads 120 an hour,
Blackwater break even 17.6 percent. See `tests/unit/`.

## Overnight loop drills, November 18
| Drill | Result |
| --- | --- |
| Loop started at 9pm | `loop-guard window` exits 3 and the master stops before doing anything |
| Change touching `src/rules`, `src/alerts`, `src/store/db.ts` | `loop-guard protected` exits 4, the change becomes a proposal |
| Planted bug merged (vendor dump profit ignores quantity) | Watchdog: tests passed before and failed after, merge reverted, changelog says "Needs Chip" |
| Harmless change merged during a Blizzard outage | Watchdog: contract fails before and after, not blamed on the change, kept |

Not yet drilled: a full agent run of `/nightly` on Chip's PC (needs his Claude desktop scheduled task and real run reports). First two nights are the drill; caps get tuned from the changelog.
