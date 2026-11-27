# Page contracts

What each page must keep showing, and in what order. Chip agreed to every line here. A new request ADDS to a page. It never removes, hides, renames away or pushes down anything listed below.

`tests/unit/page-contracts.test.ts` checks this file's rules against the code. When Chip asks for something new, add it here in the same change, so it is protected from then on.

To remove, rename or move anything below, Chip must ask for that exact change in his own words. Otherwise ask him first.

## Play card (`web/src/components/PlayCard.tsx`)

In this order: item and profit per item (big), Buy, Sell, Why, Price, Volume, List (2h, 8h, 24h, best bold), Strength chip with its breakdown.

## Now (`web/src/pages/now.tsx`)

Health strip (data time, next refresh), house status, live plays, Held back this hour (closest calls), category filters.

## Crafting, Leveling plan (`web/src/pages/crafting.tsx`)

In this order, top to bottom:
1. Range controls (from, to), materials to buy total, recipes total.
2. Sell these instead (when any).
3. **Steps table first:** Skill, Make (recipe, guide note, alternative), Crafts, Each craft takes, Learn, Colors.
4. Materials for this range: Material, Need, From your bags, Made from your bags, To buy, Cheapest way, Cost.
5. Recipes to learn: learn at, recipe, cost, where (trainer, vendor or drop, map link, unconfirmed marks).

## Crafting, Profit board

Item, Costs each, Sells each, Profit each, Sell a day, List for; profession filters; row opens sources and listing advice.

## Crafting, My materials

Paste box, saved materials list with counts.

## Flips (`web/src/pages/flips.tsx`), agreed November 24
Run status (data time, items and recipes checked, complete or incomplete), filters (All, Crafting, Flipping, risk, sort), the ranked list, Held back this hour.

Refresh button (November 26): sits in the run status card after the existing status, before the filters. It says "Checking Blizzard..." with a spinner while it works, then the result and the data time ("Data from 12 min ago; Blizzard publishes about 25 past each hour, next one about 13:25"). Nothing in the status card moved.

Refresh running on GitHub (phase 2 on GitHub storage, November 27): online, Refresh starts the hourly job on GitHub, or joins the one already running. The same button then says "Running on GitHub..." with the same spinner, and the line beside it says "Running on GitHub, usually 1 to 2 minutes" until the run ends, then "Updated on GitHub." with the data time. A run that fails says so in red. Local mode is unchanged ("Checking Blizzard..."). Nothing in the status card moved.

Discord line (November 27): a short line in the run status card, after the Refresh button and before the filters: "Discord gets Good (10g or more) and Amazing (20g or more) flips that are low or medium risk with solid evidence". The gold numbers are the live Good and Amazing flip alert settings from /api/settings. Nothing else moved.

Buy lists only what is bought (auction or vendor); craft steps go on Make ("Make first ..."); the product is never its own input (clarified November 26, nothing removed).

Make first steps sit before the Make line. When a card has more than 3 Buy lines or more than 3 Make first lines, the first 3 show and a "show N more" toggle opens the rest; nothing is removed (system review round 2, November 26). On phones the card lines use the full card width.

Flip card, in this order: rank, Crafting (green) or Flipping (blue) badge, item, family and opening line (new or rising, hours open of the last 72, repeatable or one opening), expected profit overnight (big) with units and profit per item, Buy, Make (crafts only), Sell, Price, Volume, Risk, Setup (crafts that need training), Shares, strength chip, gold per hour, amounts table (small, best, most with units, cost, sells overnight, expected profit, per hour, risk, bad case).

Who did what (phase 2, November 27): below everything on the flip card, after the notes, an "I did this" button that asks for units, and for each time the signed in person did this flip a line with units, expected cost and profit, what sold so far, and a "Sold" button that asks for units and gold received. Nothing above it moved.

Saved, not counted yet (phase 2 on GitHub storage, November 27): online, below the Sold lines on the flip card, one line for each of your writes saved since the last hourly update: "You did 3 units 2 min ago: saved, counts at the next update." Nothing above it moved.

## Settings (`web/src/pages/misc.tsx`), flip alerts added November 26
Every existing field stays in place. Below them: Good flip alert in gold (default 10), Amazing flip alert in gold (default 20), and a checkbox "Also send the old play alerts" (off by default). Then Save.

## Ledger (`web/src/pages/ledger.tsx`), phase 2, November 27
In the menu under Mine, after Watchlist. Per person table: Person, Flips done, Gold spent, Gold received, Realised minus spent, Expected, Realised against expected. Then History: every "I did this" and "Sold", newest first, with who and when.

Saved, counts at the next update (phase 2 on GitHub storage, November 27): online, below History, a list of the writes saved since the last hourly update (I did this, Sold, settings, house pins), with who and when, each marked "saved, counts at the next update". The totals above count only what the hourly update applied. Nothing above it moved.

## Login (`web/src/pages/login.tsx`), phase 2, November 27
Only when SITE_PASSWORD is set. Your name, Password, Sign in; remembered for 90 days. The menu says who is signed in, below the existing items, with Sign out.
