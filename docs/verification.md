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
| B10 | Dead house 112 answers the commodities endpoint with 200 and no `auctions` key at all, not an empty list. The contract now reads a missing key as zero listings and flags it | Chip's live run of match-house crashed on it, November 19 |
| B9 | This cloud container reaches Blizzard, GitHub raw, wago.tools and Discord | curl from the session |

## Not yet proven, blocking or provisional

| # | Claim | Status | Settled by |
| --- | --- | --- | --- |
| P1 | Live auction shapes still match the contracts in `src/blizzard/contracts.ts` | Contracts written from V2 to V17 records. Not re-run in this build because the cloud credential was rejected | `npm run contract` on first run, setup runs it too |
| P2 | Item `binding`, `quality`, `media` fields present in Forever item responses (T1, T11) | Provisional | `npm run contract` checks binding and icon |
| P3 | Deposit formula (T7) | Assumed 15 percent of vendor sell price, 1c minimum, 5x Blackwater | Chip's test listing |
| P4 | Demand from vanished listings | Provisional by nature: cancellations leak in. Excludes listings that were about to expire | Calibration report over weeks |
| P5 | Character professions from the profile API (T8) | Not wired. Professions are typed in Settings as JSON | Later release |
| P6 | Your two house ids | Chip, in the House finder | In game, one minute |

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
