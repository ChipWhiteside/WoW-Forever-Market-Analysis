# Putting Gold Finder online

This puts the site at gold.chipwhiteside.com and runs the collector every hour on GitHub. It costs nothing. Plan on about 30 minutes.

Your repository is public. That is fine: everything Gold Finder stores on GitHub is encrypted with a key only you hold.

## 1. Make the data key
This key locks your data. Keep it somewhere safe, like a password manager. If you lose it, the stored data cannot be read and the collector starts over.
1. On your computer, open a terminal (on Windows, PowerShell; on a Mac, Terminal).
2. Run this one command:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. Copy the line it prints. That is your DATA_KEY. You paste the same value in two places below.

## 2. Repository secrets
Add these before the merge in step 3. The hourly job starts as soon as the merge lands, and without them every run fails.
1. On GitHub, open the repository, then **Settings**.
2. In the left menu, open **Secrets and variables**, then **Actions**.
3. On the **Secrets** tab, press **New repository secret** for each of these:
   - `DATA_KEY`: the key from step 1.
   - `BLIZZARD_CLIENT_ID`: from your Blizzard developer account, the same as in your local `.env`.
   - `BLIZZARD_CLIENT_SECRET`: the same, from your `.env`.
   - `DISCORD_WEBHOOK_URL`: the same, from your `.env`.
   - `DISCORD_DEV_WEBHOOK_URL`: optional. Only if your `.env` has one. Without it, the job still runs.
4. Open the **Variables** tab and press **New repository variable**:
   - `APP_URL`: `https://gold.chipwhiteside.com`
5. You do not add GITHUB_TOKEN. GitHub gives the job its own.

## 3. Merge to main
GitHub only runs the hourly job from the main branch.
1. Open the repository on GitHub.
2. Open the pull request for the phase 2 branch and press **Merge pull request**, then **Confirm merge**.

## 4. A token for the site
The site needs its own key to read the data and start a refresh.
1. On GitHub, press your picture at the top right, then **Settings**.
2. At the bottom of the left menu, open **Developer settings**, then **Personal access tokens**, then **Fine grained tokens**.
3. Press **Generate new token**.
4. Name it `Gold Finder site`. Set the expiration as long as GitHub allows, and put a reminder in your calendar for that date.
5. Under **Resource owner**, pick the account that owns this repository: you, or the organization if it lives under one. An organization may have to approve the token before it works.
6. Under **Repository access**, choose **Only select repositories** and pick this repository only.
7. Under **Permissions**, then **Repository permissions**, set:
   - **Contents**: Read and write.
   - **Actions**: Read and write.
   You do not need **Workflows**. The site keeps its saved changes on a branch called `data-inbox`, which it makes on the first save. That branch holds only a short README and the encrypted changes, no workflow files, so Contents is enough.
8. Press **Generate token** and copy it. GitHub shows it only once.

## 5. Import into Vercel
1. Go to vercel.com and sign in with GitHub.
2. Press **Add New**, then **Project**, and pick this repository. Press **Import**.
3. Leave the build settings as they are. The repository already tells Vercel what to do (`npm run build:vercel`).
4. Open **Environment Variables** and add each one below. This screen puts them in every environment; step 7 limits them to Production.
   - `SITE_PASSWORD`: the password your group types to sign in.
   - `SESSION_SECRET`: any long random text. You can run the command from step 1 again and use its output.
   - `DATA_KEY`: the same key as in step 1. Exactly the same.
   - `GITHUB_TOKEN`: the token from step 4.
   - `GITHUB_REPO`: the repository as owner and name, for example `chipwhiteside/wow-forever-market-analysis`.
5. Press **Deploy**.
6. When it is done, open the project, then **Settings**, then **Node.js Version**, and pick **22.x** if it shows something else.
7. Still in **Settings**, open **Environment Variables**. For each of the five, press the three dots, then **Edit**, tick **Production** only, untick **Preview** and **Development**, and press **Save**. A preview of another branch then cannot read or change your live data.
8. Open **Deployments**, press the three dots on the newest one, then **Redeploy**. The site only sees changed variables after a redeploy.

## 6. Add gold.chipwhiteside.com
1. In the Vercel project, open **Settings**, then **Domains**.
2. Type `gold.chipwhiteside.com` and press **Add**.
3. Vercel shows a record to add where you bought chipwhiteside.com, usually a CNAME named `gold`. Add it there.
4. Wait until Vercel shows a green check. It can take a few minutes, sometimes an hour.

## 7. The first run
1. On GitHub, open the repository, then **Actions**.
2. In the left list, press **collect**.
3. Press **Run workflow**, keep the branch as main, and press the green **Run workflow**.
4. Wait, then open the run. The first run takes longer, up to about 30 minutes, because it downloads the game data (recipes, vendors, items). Later runs take about 2 minutes. A green check means it worked.
5. Open the step called **One cycle**. Near the end it says `database restored from fresh` on the first run and lists how many publishes it read.
6. Open the repository's **Releases**. A release called `data` now holds `results.json`, `ledger.json` and a `wowf` database file. They are encrypted, so opening them shows nothing readable. That is right.
7. Open gold.chipwhiteside.com, sign in with your name and the password, and open Flips. The list is there.
8. Pin your Blackwater house on the Houses page. It counts at the next update. Then press Refresh on Flips: it says "Running on GitHub, usually 1 to 2 minutes", and the list updates when it is done. When Refresh joins an hourly run that is still waiting for Blizzard to publish, it can take up to about 15 minutes, and the page says so.

From then on, the job runs at 28 past every hour on its own.

## What it costs
Nothing.
- GitHub Actions minutes are free and unlimited because the repository is public.
- The Actions cache, releases and the inbox branch are free.
- Vercel's Hobby plan is free for a site like this.

## If something goes wrong
- **The run fails at the start with "DATA_KEY is missing"**: the secret is not set, or is named differently. Check step 2.
- **The site says "could not decrypt"**: the DATA_KEY in Vercel is not the same as the one in GitHub. Paste the same value in both and redeploy.
- **Refresh says it needs GITHUB_TOKEN**: add the token in Vercel (step 5) and redeploy.
- **The run fails with "cloud cycle failed: ..."**: the last line of **One cycle** names the kind of error. Names, ids and links are left out on purpose, because anyone can read the log.
- **The site shows nothing after a day**: open Actions on GitHub and look for a red run. Open it and read the last lines of **One cycle**.
- **Flips says "Hourly updates have not run since ..."**: the newest results are over 2 hours old. Open the **Actions** tab on GitHub. GitHub turns off the schedule of a public repository after 60 days with no activity in it, and emails you first. If **collect** shows a banner that it was disabled, press **Enable workflow**. Then press **Run workflow** once, so the list is fresh at once. Any commit to the repository also counts as activity.
- **Sign in says "Too many wrong passwords"**: after 5 wrong tries in 10 minutes, the site waits 30 seconds before the next try.

## Troubleshooting
- **Every page says "The site is missing DATA_KEY; see setup guide"**: Vercel has no `DATA_KEY`, or it is not ticked for Production. Add it (step 5.4 and 5.7), then redeploy (step 5.8).
- **Every page fails and the Vercel function log shows `ERR_UNKNOWN_BUILTIN_MODULE` with `node:sqlite`**: Vercel runs a Node too old for the database. Open **Settings**, then **Node.js Version**, pick 22.x (it must be 22.13 or later), and redeploy.
- **The hourly runs stopped**: GitHub turns off the schedule of a public repository after 60 days with no activity. Open **Actions**, press **collect**, then **Enable workflow**, then **Run workflow** once.
- **A save fails with "answered 409", or Refresh says "Busy" (409)**: two saves or updates landed at the same moment. Wait a minute and try again. Nothing is lost: a refused save was never stored.
