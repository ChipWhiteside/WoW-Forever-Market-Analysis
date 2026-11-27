# Flips: your overnight money list

How to start Gold Finder and read the Flips page. Written November 26, 2026.

## 1. What the Flips page is

One list. Every way to turn copper into more copper on your two houses, ranked best first. Green cards are crafting. Blue cards are flipping (buy here, sell there). Neither is tucked away.

The rank is one number: what you can expect to make overnight if you act now. It assumes you list your goods, then sleep about 10 hours with no relisting. Unsold units lose their deposit, and the number counts that.

## 2. Start it on your PC

You need Node 22 or newer and git.

1. `npm install`
2. `npm run setup`. It asks for your Blizzard client secret and your Discord webhook, proves both work, and builds the app. To set it by hand, copy `.env.example` to `.env` and fill in `BLIZZARD_CLIENT_SECRET` and the two Discord webhook lines.
3. `npm start`. It builds the web app, then runs the engine and the server.
4. Open http://localhost:4242.

The engine collects every hour, right after each house publishes. Your PC must be on, because an hour it misses is gone for good.

Press **Refresh** at the top of the Flips page whenever you open it. It asks Blizzard for the newest publish, counts what sold, reruns every flip and shows the result in a few seconds. Blizzard publishes about 25 past each hour, so the card under the button says how old the data is and when the next publish lands. If Blizzard does not answer, it says so in red and keeps the last list.

Leave the app running even when you are not playing. It quietly saves every hourly publish. That history is how it knows what really sells, and an hour it misses is gone for good.

Auction flips need 6 hours of watched sales before they rank. Until then you see only vendor flips, and the rest wait in Held back as "learning". Leave it running and the list fills in on its own.

## 3. Read one card, line by line

Take Cerulean Dye at Ben's prices. You buy 2 Frilled Lichen at 25 to 30s each, add an Empty Vial, and the dye sells for 70 to 80s.

- **Header.** Rank, badge, item, then how many of the last 72 hours it was open and whether it is repeatable. At right, the big number: expected profit overnight, with units and profit per item.
- **Buy.** Only what you buy. Here: 2 Frilled Lichen per dye, each price, the house, and a map link.
- **Make.** The recipe, your profession, how many to make, and about how long it takes. Minutes are shown, not charged.
- **Sell.** What you list, and the price each after the house cut (5% Alliance, 15% Blackwater). Dye: about 75s listed, about 71s after the cut.
- **Price.** The cheapest listing now, and the price the engine counts on. It says why, and assumes one typical undercut.
- **Volume.** At least how many sell a day (a cautious low estimate), the middle guess, hours watched, and how many listings sit ahead of you.
- **Risk.** A level chip, then gold at stake (what you spend), the bad case (price falls to its 3 day low and only half sell, deposits lost), days to sell, and the drivers, such as a jumpy price or few sales seen.
- **Setup.** Crafts you must train: skill, cost, where to learn it. "Not known yet" is a risk.
- **Shares.** "Uses the same reagents or buyers as 1 flip above." Doing both leaves less. The card shows what is left.
- **Strength chip.** 0 to 100, how much evidence backs the numbers. Hover for the breakdown. Under 40 never shows.
- **Gold per hour.** Profit over the minutes of work. Never a gate.
- **Amounts table** (click "Show amounts"). Three rows:
  - Small: about 10 units.
  - Best: the most expected profit that is not high risk.
  - Most: the most the market can take.

For the dye: about 57s in, 71s out after the cut, about 13s 54c each. Best is about 20 to 25 crafts, most of them selling tonight, expected profit about 3g, medium risk. Most (38 crafts, the whole lichen ladder) expects about 4g 5s but is high risk. Two purchases, one post, a few minutes.

## 4. What risk levels mean

Risk sits beside the profit. It never hides a flip.

- **Low.** The bad case loses little next to what you expect to make.
- **Medium.** The bad case hurts, but you still come out near even or ahead.
- **High.** The bad case loses more than the flip is expected to make.

A flip can be high risk even when the profit looks great. Common reasons: a price that just jumped, many listings ahead of you, thin reagents, a jumpy price, or few sales seen. Big amounts push risk up because each extra unit sells later in the queue and risks a deposit. That is why Best and Most differ.

## 5. Held back this hour

The list under the cards shows the closest calls that missed, with the reason. The usual ones:

- **Learning.** Fewer than 6 hours of watched sales. It clears by itself.
- **No profit after the cut.** The sale fee eats the margin. Today's live dye and baubles often read this way.
- **Vendor price unverified.** The vendor price exists only in Classic data, not confirmed in Forever. Check it in game (see section 7).
- **Competition not measured.** The engine has not watched new listings under you long enough. It will not rank the flip as if nobody posts overnight.

## 6. Settings you may want

- **House finder (Settings).** Check the lowest price per unit for Copper Ore and Linen Cloth in a capital and at Booty Bay, then pin your Blackwater house. Until you do, flips run on Alliance house 111 only, so cross house flips cannot appear.
- **Gold on hand.** Caps every flip by its full cost to do. Set it so the list never shows what you cannot afford.
- **Only craft sub steps in my professions.** A checkbox in Settings, off by default. When on, a step in a profession you lack is bought instead when someone sells it. Leave it off if your alts cover the other professions. The recipe on the card is never blocked either way. Every card lists each profession its craft needs.
- **Crafting session, in minutes.** 30 by default. The best amount stays inside one session. The Most row may go past it and says so.
- **Alert bars, in gold.** Good (10) and Amazing (20). See section 7.
- **Time rate, silver per hour.** 0 by default, because you list and sleep. Raise it if you want minutes charged against profit.

## 7. Discord alerts

Discord only hears about the best. A flip is sent when its expected profit overnight is at or above your **Good** bar (10g by default), labeled **Amazing** at or above your **Amazing** bar (20g by default). It must also be low or medium risk, strength 75 or more, have 6 hours of watched sales, a known way to learn it, and nothing held back.

- Every flip that qualifies in the same hour is sent, Amazing first.
- The same flip is not sent again within 24 hours unless its profit grew by a quarter.
- Quiet hours hold alerts and send them when quiet ends, if the flip still holds up.
- The old play alerts are off. Turn them back on in Settings if you miss them.
- Too many alerts? Raise the bars in Settings. Too few? Lower them.
- `npx tsx scripts/alert-review.ts` lists recent alerts and whether each one held up at the next publishes.

## 8. The five in game checks

Each settles a question the data cannot.

1. **Vendor a Seasoned Wolf Kabob and Barbaric Shoulders.** Does the vendor pay what the tool says? This proves vendor prices.
2. **List one item at 2, 8 and 24 hours on Alliance and Blackwater.** Note each deposit. This settles the deposit assumption (T7), which drives every risk number and the Blackwater flips.
3. **Craft Coarse Dynamite a few times.** How many do you get each cast? Yield changes the cost per unit.
4. **Buy from one vendor each in Ratchet, Gadgetzan and Everlook.** Booty Bay is proven. This confirms those towns count as neutral.
5. **Tell the tool your Blackwater house.** Use Booty Bay screenshots with prices. Without it, no cross house flips.

## 9. When you see a flip

1. **Check the card.** Fresh data, risk you can live with, strength 60 or more.
2. **Pick an amount.** Best is the default. Take Small to test a new flip.
3. **Buy** exactly what the Buy line says, at or near those prices.
4. **Craft** the "Make first" steps, then the main recipe.
5. **Post** at the Sell price, 24 hours. Undercut a little, no more.
6. **Go to sleep.**

If prices moved while you shopped, skip it. Another flip will come.
