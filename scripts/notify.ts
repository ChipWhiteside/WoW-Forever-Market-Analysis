/** Send one message to the dev channel webhook in .env. Used by the overnight loop's morning summary. */
import { loadConfig } from '../src/config/env.ts';
import { sendDiscord } from '../src/alerts/discord.ts';
const cfg = loadConfig();
const text = process.argv.slice(2).join(' ').slice(0, 1900);
if (!cfg.discordDevWebhookUrl || !text) process.exit(0);
process.exit((await sendDiscord(cfg.discordDevWebhookUrl, `**Overnight loop**\n${text}`)) ? 0 : 1);
