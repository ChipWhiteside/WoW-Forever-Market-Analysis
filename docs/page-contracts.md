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
