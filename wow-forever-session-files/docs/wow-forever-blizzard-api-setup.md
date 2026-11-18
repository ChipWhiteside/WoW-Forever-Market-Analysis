# WoW Forever: Blizzard API Setup Runbook

Step by step credential setup and verification for the price bot. Companion to the app spec doc, which holds the architecture and the gap analysis. Do this once. Everything else in the build depends on it.

Nothing about Forever's API is officially documented. Every endpoint below was mapped by the community after the November 4, 2026 launch and can change without notice. Verify, do not assume.

## Step 1. Prerequisites

1. A Battle.net account. The one you play on is fine.
2. **A Battle.net Authenticator attached to that account.** Two factor authentication is mandatory for API access, not optional. If the authenticator app is not already on your phone, install it and attach it before anything else.
3. Nothing to pay. The developer portal is free and there is no paid tier.

## Step 2. Create the API client

1. Go to https://develop.battle.net and log in with your Battle.net account. The authenticator prompts you to approve the login.
2. Accept the Blizzard Developer API Terms of Use when prompted.
3. Click **API Access** in the top navigation, then **Create Client**.
4. **Client Name.** Globally unique across every developer account, not just yours. If Save rejects the name, that is why. Add something of your own to the end.
5. **Redirect URLs.** Required by the form. The client credentials flow never redirects a browser anywhere, so the value is unused. `http://localhost:8080/callback` is fine.
6. **Service URL.** Leave blank and tick **I do not have a service URL for this client**, which is the correct answer for a local script with no site behind it.
7. **Intended Use.** Required, and ticking the no service URL box is what makes it mandatory, because Blizzard wants to know how and from where the API is being called instead. Verified working text, confirmed November 17, 2026.

```
Personal, non commercial tool for my own account. A command line
script running locally on my own computer calls the WoW Forever
Game Data API using the client credentials flow, to read auction
house listings and item data for the character I play. No public
website, no end users, no user authentication, no redistribution
of the data.
```

8. Save. The form reports **Missing Required Fields** rather than naming which, so if it refuses, the culprit is almost always Service URL or Intended Use.
9. The portal shows a **Client ID** and a **Client Secret**. **Copy the secret now.** It is shown once. If you lose it, the portal lets you generate a new one, which invalidates the old.

Account limit is 50 clients, so one for this bot leaves plenty of room.

## Step 3. Get an access token

Client credentials flow. One POST, no user login, no browser.

```bash
curl -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" \
  -d grant_type=client_credentials \
  https://oauth.battle.net/token
```

Returns JSON with `access_token`, `token_type` of bearer, and `expires_in` of 86399 seconds. The token is good for 24 hours. Cache it and refresh on expiry. Do not request a new one per API call.

Wrap the ID and secret in quotes. A known failure is pasting them with the angle brackets or braces from an example still around them.

For the shell steps below, hold the token in a variable.

```bash
TOKEN=$(curl -s -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" \
  -d grant_type=client_credentials \
  https://oauth.battle.net/token | jq -r .access_token)
```

## Step 4. Verify Forever answers

Three namespaces exist for Forever. Game data is `static-forever-us`, live data is `dynamic-forever-us`, character data is `profile-forever-us`. Replace `us` with your region if it ever changes. Current game data version is 1.60.1_70399, pinnable as `static-1.60.1_70399-forever-us` if a build change ever breaks something.

**4a. Rulesets.** Forever has no realms. The realm index returns 404 by design. Rulesets replace them.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://us.api.blizzard.com/data/wow/ruleset/index?namespace=dynamic-forever-us" | jq
```

Expect 1 PvP, 2 Normal, 3 Roleplay, 15 Roleplay PvP. **You are on Normal, so ruleset 2.**

**4b. Auction house index.** The trailing slash is required. Without it you get a 404 and will think the endpoint is broken.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://us.api.blizzard.com/data/wow/ruleset/2/auctions/?namespace=dynamic-forever-us" | jq
```

Expect 15 houses, ids 110 to 121 and 123 to 125, five each named Alliance Auction House, Horde Auction House and Blackwater Auction House. Houses 112, 115 and 118, one per faction, carry no auctions field. Skip those.

**4c. One house.** Write it to disk. Responses run to 9 MB on the busy houses, with 50,000 to 68,000 auctions.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://us.api.blizzard.com/data/wow/ruleset/2/auctions/110?namespace=dynamic-forever-us" \
  -o house110.json
```

Returns `id`, `name`, `auctions`, `commodities` and `ruleset`. Auction entries carry `id`, `item`, `buyout`, optional `bid`, `quantity` and `time_left`. Some are bid only with no buyout, which must be excluded from floor calculations. Commodity entries carry `unit_price` instead of `buyout`.

**4d. One item.** Confirms the static namespace and gives you the vendor sell price the opportunity scanner needs.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://us.api.blizzard.com/data/wow/item/2589?namespace=static-forever-us" | jq
```

Item 2589 should come back as Linen Cloth. The response carries `purchase_price` and `sell_price` in copper. Read the gap analysis in the spec doc before trusting either number.

## Step 5. Identify your auction house

This is the step that cannot be skipped and cannot be solved from the API alone.

Every ruleset currently returns the same 15 houses with the same auctions, which the community survey flags as a probable bug. So the ruleset id does not actually prove which market you are reading. Five houses share the name Alliance Auction House and the API does not say which is yours.

Procedure.

1. Open the auction house in game. Search one high volume item you can see clearly, for example Copper Ore or Linen Cloth. Write down the lowest buyout and the number of units at that price.
2. For each Alliance house id, compute the same two numbers from a fresh snapshot.
3. The house that matches both is yours. Pin that id in config.
4. Repeat the check on a second item before trusting the match. One item can coincide across markets.
5. Redo this check if Blizzard changes the house layout or if the numbers ever stop matching. A silent switch to the wrong house would poison every number downstream.

## Step 6. Store the credentials

1. `.env` file, `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`, loaded at runtime.
2. `.env` in `.gitignore` before the first commit, not after.
3. Never in source, never in a config file that gets committed, never pasted into a chat. If a secret leaks, regenerate it in the portal.

## Step 7. Rate limits and the polling budget

1. **36,000 requests per hour and 100 requests per second,** enforced per client, not per token.
2. Exceeding the per second limit returns 429. Exceeding the hourly limit puts the client into sustained 429 responses once it passes the cap plus roughly 10 percent.
3. Several developers report 429 responses well under the stated limits, so build retry with backoff from the start rather than treating a 429 as a bug.
4. Your actual budget use is trivial. One house polled every 15 minutes is 4 requests an hour against a 36,000 limit.
5. The only thing that could burn the budget is item name backfill, roughly 1,500 distinct ids per house. Do it once, cache the results forever, and never look up a name you already have.
6. Send `If-Modified-Since` with the previous `Last-Modified` value on every poll. Unchanged snapshots return 304 with no body, which costs almost nothing and stores nothing.

## Step 8. Known failure modes

1. **Missing Required Fields on the create form.** Service URL or Intended Use. See step 2.
2. **Client name rejected.** Names are globally unique across all developer accounts.
3. **Missing trailing slash on the auctions index.** 404 that looks like a missing endpoint.
4. **Angle brackets left around the ID or secret.** Token request fails.
5. **Requesting a token per call.** Works until it rate limits, then fails confusingly.
6. **Item endpoint 404.** Expected for a large share of ids. See the spec doc. It is a data coverage hole, not a credential problem.
7. **Old endpoints.** `/data/wow/auctions/commodities` returns 404 for Forever. Commodities live under each house.
8. **Summing across rulesets.** Every ruleset returns the same houses today. Summing would multiply your totals by four.

## Step 9. Completion checklist

1. Authenticator attached
2. Client created, ID and secret stored in `.env`, `.env` ignored by git
3. Token request returns an access token
4. Ruleset index returns the four rulesets
5. House index returns 15 houses
6. One house snapshot saved to disk
7. Item 2589 returns Linen Cloth with a sell price
8. Your house id confirmed against two in game prices and written into config

Once 1 through 7 pass, the build can start. Step 8 needs you in game.
