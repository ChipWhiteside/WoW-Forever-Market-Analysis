# Changelog

What changed, newest last. The overnight loop appends here every night it runs.

## 2026-11-18, initial build

- Engine, detectors, alerts, app and overnight loop built in the first session. See docs/build-plan.md and docs/verification.md.

## 2026-11-19, Chip's first feedback round

- **Play cards rebuilt.** The item and its profit per item lead. Below them, bullet lines: Buy (where, price, who, location), Sell (where, price, location), Volume (sales a day, what is worth doing today), and List (2h, 8h, 24h deposits with the best one bold). Every location links to the new Map.
- **Sort order** is profit per item times a realistic number of units: your share of daily sales, 20 percent by default, set in Settings.
- **Top bar** shows only when the data is from and when the next refresh lands. Missed hours moved to the Health page.
- **House status** says exactly which house is still unpicked.
- **Deposits** follow your Coarse Stone listing: 20 percent of the vendor price per hour. Deposits are treated as refunded on a sale and lost on expiry.
- **Map tab** with zone maps and pins. Click a location on any play to jump there.
- **Crafting** is per single item, with sales a day and a listing plan. New Leveling plan tab built from the Blacksmithing guide, using your materials first, and a My materials tab you can paste a list into.
- **Settings** has a field per profession and the sales share.
- **docs/blacksmithing-plan.md**: the guide turned into a full 1 to 300 plan with real recipe colors, crafts per step and materials, including what 33 to 150 takes from your current skill.

## 2026-11-19, fake opportunities fixed

- The 76g Blacksmith Hammer and 28g Light Mail Armor were junk. Two agents traced and researched it. Three faults stacked: expired 2 hour listings counted as sales, one troll listing set the price, and sales at 1s were multiplied by a 90g price.
- Sales now exclude anything that could have expired, cancel and relist on thin markets, and stackables that vanished while a cheaper stack stayed up.
- Prices: a play never claims more than where sales actually happened. Common items over 20x their vendor price, and vendor items over 20x what the vendor charges, need real sales there.
- Every resale play carries a 0 to 100 confidence score. Below 40 is hidden, 40 to 59 shows as "watch only" and never alerts.
- Plays only come from the houses you picked.

## 2026-11-19, minimum profit per item

- Plays under 1 silver profit per item are never stored, shown or alerted. Change it in Settings, "Minimum profit per item".
