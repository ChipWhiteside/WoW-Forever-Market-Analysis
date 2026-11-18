import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Load .env from the project root into process.env without overwriting real env vars. */
export function loadDotEnv(path = join(PROJECT_ROOT, '.env')): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    const val = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export interface AppConfig {
  region: 'us';
  clientId: string;
  clientSecret: string;
  discordWebhookUrl: string | null;
  /** second channel for dev logs, loop summaries and health problems; falls back to nothing, never to the plays channel */
  discordDevWebhookUrl: string | null;
  dataDir: string;
  port: number;
}

export function loadConfig(): AppConfig {
  loadDotEnv();
  const dataDir = process.env.DATA_DIR || join(homedir(), '.wowf-gold-finder');
  for (const sub of ['', 'raw', 'datasets', 'reports', 'backups']) mkdirSync(join(dataDir, sub), { recursive: true });
  return {
    region: 'us',
    clientId: process.env.BLIZZARD_CLIENT_ID ?? '',
    clientSecret: process.env.BLIZZARD_CLIENT_SECRET ?? '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
    discordDevWebhookUrl: process.env.DISCORD_DEV_WEBHOOK_URL || null,
    dataDir,
    port: Number(process.env.PORT || 4242),
  };
}
