# WoW Forever Gold Finder

Finds gold making plays on your WoW Forever auction houses within minutes of every hourly publish, and pings your phone only when one is worth your time.

It reads every listing on the Alliance and Blackwater houses, checks each item against what vendors pay and charge, recipes, drop data and its own price history, then ranks the plays: vendor dumps, vendor supply, underpriced listings, cross house flips, crafting margins, sell now and world drops. You decide what to do with them in game.

Plan: `docs/build-plan.md`. What is proven: `docs/verification.md`. What changed: `docs/CHANGELOG.md`.

## Install on your PC, about ten minutes

You need Node 22 LTS or newer (nodejs.org) and git.

```bash
git clone https://github.com/ChipWhiteside/WoW-Forever-Market-Analysis.git
```

```bash
cd WoW-Forever-Market-Analysis && git checkout claude/loving-keller-okyqnz
```

```bash
npm install
```

```bash
npm run setup
```

Setup asks for your Blizzard client secret and your Discord webhook, proves both work, builds the app, and starts the engine in the background and adds it to your Windows Startup folder so it runs at every login. No admin rights needed. To stop it for good, delete `WoWF Gold Finder.vbs` from the Startup folder (Win+R, `shell:startup`). Then open http://localhost:4242. In Chrome or Edge use the menu, Install app, to get it as its own desktop window.

### Discord, five minutes
In your server, make a **Gold Finder** category with two channels:
- `#gold-plays` for market opportunities. Set notifications to All messages so your phone buzzes.
- `#gold-dev` for overnight loop summaries, changelog entries and health problems. Mute it and read it when you sit down.

For each channel: Edit Channel, Integrations, Webhooks, New Webhook, Copy Webhook URL. Setup asks for both.

### Then, once
1. **Settings, House finder.** In game, check the lowest price per unit for Copper Ore and Linen Cloth at a capital and at Booty Bay. Click the two houses that match. Alerts start after this.
2. **Settings.** Your starting gold, home city, and your professions as JSON, for example `{"Blacksmithing": 75, "Mining": 90}`.

## What runs, and when

| When | What | Uses Claude |
| --- | --- | --- |
| Every 2 minutes | Checks every house for a new publish (free when nothing changed) | No |
| Each publish | Stores history, finds plays, sends one Discord message if anything new clears your bar | No |
| Daily | Refreshes vendor, loot and recipe data, vendor sell prices, backups, rollups | No |
| Nightly 1am to 5am | The overnight improvement loop, if you set it up below | Yes, capped |

Your PC must be on for history to be recorded. Any hour it is off is gone for good, and the Health page shows the gaps.

## Overnight improvement loop, optional, five minutes
1. In the Claude desktop app, create a scheduled task in this project folder, daily at 1:00am, with the prompt `/nightly`.
2. Turn on Keep computer awake in the Claude desktop app, and leave it open overnight.
3. Claude settings, Usage: turn usage credits off, so the loop can never spend past your plan.
4. Each morning read the Changelog page, or the Discord summary.

The loop audits the data, fixes what it can on its own branch, tests and reviews every change, and merges only when both pass. Anything touching the profit math, alerts, stored data or its own guardrails becomes a proposal for you instead. A watchdog reverts any merged change that breaks a check that passed before.

## Useful commands
`npm run contract` live check of every data source · `npm test` · `npm run engine` run in a terminal instead of the background

## Credits
Vendor, loot and item name data from [Efficient Games](https://efficient.games), licensed under CC BY 4.0, merged across builds. Recipe skill thresholds from the game's SkillLineAbility table via wago.tools. Auction and item data from the Blizzard API. World of Warcraft is a trademark of Blizzard Entertainment.
