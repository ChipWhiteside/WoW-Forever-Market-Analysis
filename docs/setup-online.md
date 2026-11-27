# Putting Gold Finder online

This puts the site at gold.chipwhiteside.com and runs the collector every hour on GitHub. It costs nothing. Plan on about 30 minutes.

Your repository is public. That is fine: everything Gold Finder stores on GitHub is encrypted with a key only you hold.

## 1. Merge to main
GitHub only runs the hourly job from the main branch.
1. Open the repository on GitHub.
2. Open the pull request for the phase 2 branch and press **Merge pull request**, then **Confirm merge**.

## 2. Make the data key
This key locks your data. Keep it somewhere safe, like a password manager. If you lose it, the stored data cannot be read and the collector starts over.
1. On your computer, open a terminal (on Windows, PowerShell; on a Mac, Terminal).
2. Run this one command:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. Copy the line it prints. That is your DATA_KEY. You paste the same value in two places below.

## 3. Repository secrets
1. On GitHub, open the repository, then **Settings**.
2. In the left menu, open **Secrets and variables**, then **Actions**.
3. On the **Secrets** tab, press **New repository secret** for each of these:
   - `DATA_KEY`: the key from step 2.
   - `BLIZZARD_CLIENT_ID`: from your Blizzard developer account, the same as in your local `.env`.
   - `BLIZZARD_CLIENT_SECRET`: the same, from your `.env`.
   - `DISCORD_WEBHOOK_URL`: the same, from your `.env`.
4. Open the **Variables** tab and press **New repository variable**:
   - `APP_URL`: `https://gold.chipwhiteside.com`
5. You do not add GITHUB_TOKEN. GitHub gives the job its own.

## 4. A token for the site
The site needs its own key to read the data and start a refresh.
1. On GitHub, press your picture at the top right, then **Settings**.
2. At the bottom of the left menu, open **Developer settings**, then **Personal access tokens**, then **Fine grained tokens**.
3. Press **Generate new token**.
4. Name it `Gold Finder site`. Set the expiration as long as GitHub allows, and put a reminder in your calendar for that date.
5. Under **Repository access**, choose **Only select repositories** and pick this repository only.
6. Under **Permissions**, then **Repository permissions**, set:
   - **Contents**: Read and write.
   - **Actions**: Read and write.
7. Press **Generate token** and copy it. GitHub shows it only once.

## 5. Import into Vercel
1. Go to vercel.com and sign in with GitHub.
2. Press **Add New**, then **Project**, and pick this repository. Press **Import**.
3. Leave the build settings as they are. The repository already tells Vercel what to do.
4. Open **Environment Variables** and add:
   - `SITE_PASSWORD`: the password your group types to sign in.
   - `SESSION_SECRET`: any long random text. You can run the command from step 2 again and use its output.
   - `DATA_KEY`: the same key as in step 2. Exactly the same.
   - `GITHUB_TOKEN`: the token from step 4.
   - `GITHUB_REPO`: the repository as owner and name, for example `chipwhiteside/wow-forever-market-analysis`.
5. Press **Deploy**.
6. When it is done, open the project, then **Settings**, then **Node.js Version**, and pick **22.x** if it shows something else. Then redeploy.

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
8. Pin your Blackwater house on the Houses page. It counts at the next update. Then press Refresh on Flips: it says "Running on GitHub, usually 1 to 2 minutes", and the list updates when it is done.

From then on, the job runs at 28 past every hour on its own.

## What it costs
Nothing.
- GitHub Actions minutes are free and unlimited because the repository is public.
- The Actions cache, releases and the inbox branch are free.
- Vercel's Hobby plan is free for a site like this.

## If something goes wrong
- **The run fails at the start with "DATA_KEY is missing"**: the secret is not set, or is named differently. Check step 3.
- **The site says "could not decrypt"**: the DATA_KEY in Vercel is not the same as the one in GitHub. Paste the same value in both and redeploy.
- **Refresh says it needs GITHUB_TOKEN**: add the token in Vercel (step 5) and redeploy.
- **The site shows nothing after a day**: open Actions on GitHub and look for a red run. Open it and read the last lines of **One cycle**.
